import * as crypto from 'crypto'
import * as os from 'os'
import forge from 'node-forge'

// 本機 CA 與 TLS 憑證。
//
// 為什麼要自己當 CA：iOS 的 PWA（加入主畫面、Service Worker、Web Push）只在「可信任的 HTTPS」下運作，
// 自簽憑證點「仍要前往」也不行。所以桌面產生一張 CA，使用者在 iPhone 安裝並開啟完全信任，
// 之後每次區網 IP 變動就用這張 CA 重簽 server 憑證，手機不必重裝。
//
// 風險控管：被手機信任的 CA 若外洩，理論上能簽任何網站。所以 CA 帶 critical 的 Name Constraints，
// 只准簽私有 IPv4 位址與 *.local 主機名，外洩也簽不出能騙過手機的 google.com 憑證。

export interface CertPair {
  certPem: string
  keyPem: string
}

// RFC 1918 私有網段 + link-local：區網唯一會出現的位址
const PRIVATE_V4: Array<[number[], number[]]> = [
  [[10, 0, 0, 0], [255, 0, 0, 0]],
  [[172, 16, 0, 0], [255, 240, 0, 0]],
  [[192, 168, 0, 0], [255, 255, 0, 0]],
  [[169, 254, 0, 0], [255, 255, 0, 0]]
]

export function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip)
  if (!m) return false
  const b = m.slice(1).map(Number)
  return PRIVATE_V4.some(([net, mask]) => b.every((x, i) => (x & mask[i]) === net[i]))
}

/**
 * 這個 Origin 是不是「我們自己的 App」？
 * 兩種算：本機提供的 PWA，以及同一個 App 跑在區網上另一台電腦的 origin
 * （手機要在一個畫面裡切換多台電腦，WebSocket 因此是跨 origin 的）。
 * 通過這關只是拿到一條連線，五秒內沒有有效 token 一樣被斷開。
 */
export function isAllowedOrigin(origin: string | undefined, host: string): boolean {
  if (!origin) return false
  if (origin === `https://${host}`) return true
  try {
    const u = new URL(origin)
    if (u.protocol !== 'https:') return false
    const h = u.hostname.replace(/^\[|\]$/g, '')
    return isPrivateIPv4(h) || /^[a-z0-9][a-z0-9-]*\.local$/i.test(h)
  } catch {
    return false
  }
}

/** 本機所有私有 IPv4（192.168 優先，通常就是家用 Wi-Fi 那張網卡） */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && isPrivateIPv4(a.address) && !a.address.startsWith('169.254.')) {
        out.push(a.address)
      }
    }
  }
  const rank = (ip: string): number => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2)
  return Array.from(new Set(out)).sort((a, b) => rank(a) - rank(b))
}

/** 能放進 *.local 的主機名；奇怪字元的主機名就不放，只靠 IP */
export function localHostname(): string | null {
  const h = os.hostname().split('.')[0].toLowerCase()
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(h) ? `${h}.local` : null
}

function newRsaKeys(): forge.pki.rsa.KeyPair {
  // 用 Node 原生產生金鑰（毫秒級）；forge 純 JS 產 2048-bit 會卡住 main process 好幾秒
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string
  const priv = forge.pki.privateKeyFromPem(pem) as forge.pki.rsa.PrivateKey
  const pub = forge.pki.setRsaPublicKey(priv.n, priv.e)
  return { privateKey: priv, publicKey: pub }
}

function randomSerial(): string {
  const b = crypto.randomBytes(16)
  b[0] &= 0x7f // 正數
  return b.toString('hex')
}

function nameConstraintsDer(): string {
  const { asn1 } = forge
  const subtree = (generalName: forge.asn1.Asn1): forge.asn1.Asn1 =>
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [generalName])
  const ipSubtree = (net: number[], mask: number[]): forge.asn1.Asn1 =>
    subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 7, false, String.fromCharCode(...net, ...mask)))
  const permitted = asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
    ...PRIVATE_V4.map(([n, m]) => ipSubtree(n, m)),
    subtree(asn1.create(asn1.Class.CONTEXT_SPECIFIC, 2, false, 'local'))
  ])
  return asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [permitted])).getBytes()
}

export function createCa(label: string): CertPair {
  const keys = newRsaKeys()
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 5 * 365 * 24 * 3600_000)
  const subject = [
    { name: 'commonName', value: `Agent Workbench Local CA (${label})` },
    { name: 'organizationName', value: 'Agent Workbench' }
  ]
  cert.setSubject(subject)
  cert.setIssuer(subject)
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    { id: '2.5.29.30', critical: true, value: nameConstraintsDer() }
  ])
  cert.sign(keys.privateKey, forge.md.sha256.create())
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) }
}

/**
 * 以 CA 簽發 server 憑證。符合 iOS 13+ 的 TLS 憑證要求：
 * RSA 2048、SHA-256、SAN 必填、EKU serverAuth、效期不超過 825 天（這裡用 397 天）。
 */
export function issueServerCert(ca: CertPair, ips: string[], dnsNames: string[]): CertPair {
  const caCert = forge.pki.certificateFromPem(ca.certPem)
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem)
  const keys = newRsaKeys()
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = randomSerial()
  cert.validity.notBefore = new Date(Date.now() - 60_000)
  cert.validity.notAfter = new Date(Date.now() + 397 * 24 * 3600_000)
  cert.setSubject([{ name: 'commonName', value: 'Agent Workbench Remote' }])
  cert.setIssuer(caCert.subject.attributes)
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [...ips.map((ip) => ({ type: 7, ip })), ...dnsNames.map((value) => ({ type: 2, value }))]
    },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() }
  ])
  cert.sign(caKey, forge.md.sha256.create())
  return { certPem: forge.pki.certificateToPem(cert), keyPem: forge.pki.privateKeyToPem(keys.privateKey) }
}

/** 憑證 SAN 是否仍涵蓋目前的 IP / 主機名，且離到期還有 30 天以上 */
export function certCovers(certPem: string, ips: string[], dnsNames: string[]): boolean {
  try {
    const x = new crypto.X509Certificate(certPem)
    if (new Date(x.validTo).getTime() - Date.now() < 30 * 24 * 3600_000) return false
    // 逐項比對，不能用 includes：`IP Address:192.168.1.1` 會誤中 `...192.168.1.10`，
    // 於是 IP 換成 .1 時以為憑證還涵蓋，不重簽，手機連進來就 TLS 名稱不符。
    const entries = (x.subjectAltName || '').split(',').map((s) => s.trim())
    return ips.every((ip) => entries.includes(`IP Address:${ip}`)) && dnsNames.every((d) => entries.includes(`DNS:${d}`))
  } catch {
    return false
  }
}

export function fingerprint256(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint256
}

export function certDer(certPem: string): Buffer {
  return new crypto.X509Certificate(certPem).raw
}
