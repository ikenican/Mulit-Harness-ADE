// 自我檢查：node --experimental-strip-types scripts/check-remote.mts
// 驗證手機遠端控制的密碼學部分：本機 CA 的名稱限制、server 憑證、Web Push 加密與 VAPID 簽章。
import assert from 'node:assert'
import * as crypto from 'node:crypto'
import * as tls from 'node:tls'
import { createCa, issueServerCert, certCovers, isPrivateIPv4 } from '../src/main/remote/certs.ts'
import { encryptPayload, generateVapidKeys, vapidAuthHeader } from '../src/main/remote/webpush.ts'
import { parsePrompt, questionPreview } from '../src/renderer/remote/prompt.ts'

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

console.log('remote ok')
