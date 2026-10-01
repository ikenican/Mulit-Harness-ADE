// 自我檢查：node --experimental-strip-types scripts/check-remote.mts
// 驗證手機遠端控制的密碼學部分：本機 CA 的名稱限制、server 憑證、Web Push 加密與 VAPID 簽章。
import assert from 'node:assert'
import * as crypto from 'node:crypto'
import * as tls from 'node:tls'
import { createCa, issueServerCert, certCovers, isAllowedOrigin, isPrivateIPv4 } from '../src/main/remote/certs.ts'
import { encryptPayload, generateVapidKeys, vapidAuthHeader } from '../src/main/remote/webpush.ts'
import { parsePrompt, questionPreview } from '../src/renderer/remote/prompt.ts'
import { sessionStatus } from '../src/shared/remoteProtocol.ts'
import { PreviewProxy } from '../src/main/remote/preview.ts'
import * as http from 'node:http'
import * as https from 'node:https'
import type { AddressInfo } from 'node:net'

// —— 私有網段判斷 ——
assert.ok(isPrivateIPv4('192.168.1.20'))
assert.ok(isPrivateIPv4('10.1.2.3'))
assert.ok(isPrivateIPv4('172.31.0.1'))
assert.ok(!isPrivateIPv4('172.32.0.1'))
assert.ok(!isPrivateIPv4('8.8.8.8'))
assert.ok(!isPrivateIPv4('100.64.0.1')) // CGNAT 不算區網

// —— 憑證：區網 IP 能用，公網名稱被 CA 的 Name Constraints 擋下 ——
const ca = createCa('check')
const good = issueServerCert(ca, ['192.168.50.7'], ['box.local'])
assert.ok(certCovers(good.certPem, ['192.168.50.7'], ['box.local']))
assert.ok(!certCovers(good.certPem, ['192.168.50.8'], []))
// SAN 是 192.168.50.7，不可以讓 .5 這種前綴相同的位址誤判成已涵蓋（否則換 IP 後不重簽）
{
  const wide = issueServerCert(ca, ['192.168.50.70'], [])
  assert.ok(certCovers(wide.certPem, ['192.168.50.70'], []))
  assert.ok(!certCovers(wide.certPem, ['192.168.50.7'], []))
}

async function handshake(cert: { certPem: string; keyPem: string }, servername: string): Promise<string> {
  const server = tls.createServer({ cert: cert.certPem, key: cert.keyPem }, (s) => s.end())
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  try {
    return await new Promise<string>((resolve) => {
      const s = tls.connect({ host: '127.0.0.1', port, servername, ca: ca.certPem }, () => {
        s.end()
        resolve('ok')
      })
      s.on('error', (e) => resolve(e.message))
    })
  } finally {
    server.close()
  }
}
assert.equal(await handshake(good, 'box.local'), 'ok')
const evil = issueServerCert(ca, [], ['www.google.com'])
assert.match(await handshake(evil, 'www.google.com'), /subtree/)

// —— Web Push：用 RFC 8291 的接收端流程解密，確認加密格式正確 ——
function decrypt(body: Buffer, ua: crypto.ECDH, auth: Buffer): string {
  const salt = body.subarray(0, 16)
  const idlen = body[20]
  const asPublic = body.subarray(21, 21 + idlen)
  const ct = body.subarray(21 + idlen)
  const h = (k: Buffer, d: Buffer): Buffer => crypto.createHmac('sha256', k).update(d).digest()
  const prkKey = h(auth, ua.computeSecret(asPublic))
  const ikm = h(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic, Buffer.from([1])]))
  const prk = h(salt, ikm)
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(-16))
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()])
  assert.equal(pt[pt.length - 1], 2) // 最後一個 record 的分隔符
  return pt.subarray(0, -1).toString()
}
const ua = crypto.createECDH('prime256v1')
ua.generateKeys()
const auth = crypto.randomBytes(16)
const sub = {
  endpoint: 'https://web.push.apple.com/QGx',
  keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
}
const msg = JSON.stringify({ title: '⏳ Claude Code 等待你的回覆' })
assert.equal(decrypt(encryptPayload(sub, Buffer.from(msg)), ua, auth), msg)

// —— VAPID：JWT 用公鑰驗得過，aud 是推播服務的 origin ——
const keys = generateVapidKeys()
const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(vapidAuthHeader(sub.endpoint, keys, 'https://example.com'))!
const pub = Buffer.from(m[4], 'base64url')
assert.equal(pub.length, 65)
const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }
assert.ok(
  crypto.verify(
    'sha256',
    Buffer.from(`${m[1]}.${m[2]}`),
    { key: crypto.createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
    Buffer.from(m[3], 'base64url')
  )
)
assert.equal(JSON.parse(Buffer.from(m[2], 'base64url').toString()).aud, 'https://web.push.apple.com')

// —— 審批提示解析：手機把選項顯示成有文字的按鈕 ——
const claudeScreen = [
  '╭──────────────────────────────────────────────╮',
  '│ Bash command                                  │',
  '│                                               │',
  '│   rm -rf build/                               │',
  '│   Remove the build directory                  │',
  '│                                               │',
  '│ Do you want to proceed?                       │',
  '│ ❯ 1. Yes                                      │',
  "│   2. Yes, and don't ask again for rm commands │",
  '│      in this project                          │',
  '│   3. No, and tell Claude what to do           │',
  '│      differently (esc)                        │',
  '╰──────────────────────────────────────────────╯'
].join('\n')
const cp = parsePrompt(claudeScreen)!
assert.equal(cp.question, 'Do you want to proceed?')
assert.deepEqual(cp.details, ['rm -rf build/', 'Remove the build directory'])
assert.deepEqual(
  cp.options.map((o) => [o.key, o.label, o.selected]),
  [
    ['1', 'Yes', true],
    ['2', "Yes, and don't ask again for rm commands in this project", false],
    ['3', 'No, and tell Claude what to do differently', false]
  ]
)
const codex = parsePrompt('Allow command?\n$ npm test\n› 1. Yes, proceed (y)\n  2. Always (a)\n  3. No (esc)')!
assert.deepEqual(codex.options.map((o) => o.key), ['y', 'a', '3'])
assert.equal(codex.options[2].label, 'No')
assert.equal(codex.question, 'Allow command?')
const yn = parsePrompt('some output\nOverwrite file? [y/N]')!
assert.deepEqual(yn.options.map((o) => [o.key, o.selected]), [['y', false], ['n', true]])
assert.equal(parsePrompt('just output\n1. not a menu'), null)
assert.equal(questionPreview('foo\n│ Do you want to proceed? │\n│ ❯ 1. Yes │'), 'Do you want to proceed?')

// —— WebSocket 來源：自己的 PWA，或同一個 App 在區網另一台電腦上的 origin ——
{
  const HOST = '192.168.50.7:47600'
  assert.ok(isAllowedOrigin(`https://${HOST}`, HOST), '自己的 PWA')
  assert.ok(isAllowedOrigin('https://192.168.1.20:47600', HOST), '另一台電腦上的同一個 App')
  assert.ok(isAllowedOrigin('https://10.1.2.3:47600', HOST))
  assert.ok(isAllowedOrigin('https://box.local:47600', HOST))
  // 公網來源、明文、以及沒有 Origin 的一律擋掉
  assert.ok(!isAllowedOrigin('https://evil.example.com', HOST))
  assert.ok(!isAllowedOrigin('https://8.8.8.8', HOST))
  assert.ok(!isAllowedOrigin('http://192.168.1.20:47600', HOST))
  assert.ok(!isAllowedOrigin('null', HOST))
  assert.ok(!isAllowedOrigin(undefined, HOST))
  // 只是像 .local 的網域名不算（evil.local.example.com）
  assert.ok(!isAllowedOrigin('https://evil.local.example.com', HOST))
}

// —— 終端狀態：只看桌面送來的 busy，不看時鐘 ——
const base = { id: 'a', needsApproval: false, busy: false }
assert.equal(sessionStatus(base), 'idle')
assert.equal(sessionStatus({ ...base, busy: true }), 'running')
// 等你回覆優先於執行中
assert.equal(sessionStatus({ ...base, needsApproval: true, busy: true }), 'waiting')
// activity 事件（live）蓋掉 state 的初值，兩個方向都要蓋得掉
assert.equal(sessionStatus(base, { a: true }), 'running')
assert.equal(sessionStatus({ ...base, busy: true }, { a: false }), 'idle')
// 別的 session 的 activity 不會影響這個
assert.equal(sessionStatus(base, { b: true }), 'idle')

// —— 手機預覽代理：ticket 換 cookie，沒 cookie 不給過 ——
{
  const fake = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Frame-Options': 'DENY' })
    res.end(`hello ${req.url}`)
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()))
  const devPort = (fake.address() as AddressInfo).port

  const proxy = new PreviewProxy((p) => p === devPort)
  assert.equal(proxy.issueUrl('127.0.0.1', devPort), null, '沒啟動就不該發得出網址')
  const leaf = issueServerCert(ca, ['192.168.50.7'], [])
  const proxyPort = devPort + 1
  await proxy.start(proxyPort, leaf.certPem, leaf.keyPem, () => {})

  const get = (path: string, cookie?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      const req = https.request(
        { host: '127.0.0.1', port: proxyPort, path, rejectUnauthorized: false, headers: cookie ? { cookie } : {} },
        (res) => {
          let body = ''
          res.on('data', (c) => (body += c))
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }))
        }
      )
      req.on('error', reject)
      req.end()
    })

  // 不認識的 port 不給代理
  assert.equal(proxy.issueUrl('127.0.0.1', devPort + 500), null)

  const url = proxy.issueUrl('127.0.0.1', devPort)!
  assert.match(url, new RegExp(`^https://127\\.0\\.0\\.1:${proxyPort}/__aw\\?t=`))
  const authPath = url.slice(url.indexOf('/__aw'))

  // 沒 cookie：擋
  assert.equal((await get('/')).status, 403)
  // 亂簽的 cookie：擋
  assert.equal((await get('/', `aw_preview=${devPort}.not-a-signature`)).status, 403)

  // ticket 換 cookie
  const authed = await get(authPath)
  assert.equal(authed.status, 302)
  const setCookie = String(authed.headers['set-cookie']?.[0] ?? '')
  assert.match(setCookie, new RegExp(`^aw_preview=${devPort}\\.[A-Za-z0-9_-]+;`))
  assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('Secure'))
  const cookie = setCookie.split(';')[0]

  // ticket 是一次性的
  assert.equal((await get(authPath)).status, 403)

  // 帶 cookie 才代理得到 dev server，且不能把 X-Frame-Options 傳下去（否則手機 iframe 框不住）
  const page = await get('/index.html?x=1', cookie)
  assert.equal(page.status, 200)
  assert.equal(page.body, 'hello /index.html?x=1')
  assert.equal(page.headers['x-frame-options'], undefined)

  // 停掉之後 cookie 也沒用（伺服器不在了）
  await proxy.stop()
  await assert.rejects(() => get('/', cookie))
  await new Promise<void>((r) => fake.close(() => r()))
}

console.log('remote ok')
