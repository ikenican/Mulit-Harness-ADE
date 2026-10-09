import * as crypto from 'crypto'
import * as https from 'https'

// Web Push 發送端（RFC 8030 傳送、RFC 8291 aes128gcm 加密、RFC 8292 VAPID）。
// 自己實作約百行，換掉 web-push 套件（MPL 授權、連帶一串相依）。
// 推播內容先以手機產生的公鑰加密，Apple 的推播伺服器只看得到密文。

export interface PushSubscriptionJSON {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export interface VapidKeys {
  /** 未壓縮 P-256 公鑰（65 bytes）的 base64url，給瀏覽器 applicationServerKey 用 */
  publicKey: string
  /** PKCS#8 PEM */
  privateKeyPem: string
}

const b64u = (b: Buffer): string => b.toString('base64url')

export function generateVapidKeys(): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const jwk = publicKey.export({ format: 'jwk' })
  const raw = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url')
  ])
  return { publicKey: b64u(raw), privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string }
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest()
}

/**
 * RFC 8291 aes128gcm 加密，輸出含 header 的完整 body。
 * asKeys / salt 只給測試注入固定值用，正式呼叫一律隨機。
 */
export function encryptPayload(
  sub: PushSubscriptionJSON,
  plaintext: Buffer,
  test?: { asPrivate: crypto.ECDH; salt: Buffer }
): Buffer {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url')
  const authSecret = Buffer.from(sub.keys.auth, 'base64url')
  let ecdh = test?.asPrivate
  if (!ecdh) {
    ecdh = crypto.createECDH('prime256v1')
    ecdh.generateKeys()
  }
  const asPublic = ecdh.getPublicKey()
  const ecdhSecret = ecdh.computeSecret(uaPublic)
  const salt = test?.salt ?? crypto.randomBytes(16)

  const prkKey = hmac(authSecret, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12)

  // 單一 record：明文後接 0x02（最後一個 record 的分隔符）
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(4096)
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body])
}

export function vapidAuthHeader(endpoint: string, keys: VapidKeys, subject: string): string {
  const aud = new URL(endpoint).origin
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject }))
  )
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), {
    key: keys.privateKeyPem,
    dsaEncoding: 'ieee-p1363'
  })
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${keys.publicKey}`
}

export interface PushResult {
  status: number
  /** 404 / 410：訂閱已失效（使用者移除 App 或關閉通知），呼叫端應刪掉 */
  gone: boolean
}

export function sendPush(
  sub: PushSubscriptionJSON,
  payload: object,
  keys: VapidKeys,
  subject: string
): Promise<PushResult> {
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)))
  const url = new URL(sub.endpoint)
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        timeout: 15_000,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Encoding': 'aes128gcm',
          'Content-Length': body.length,
          TTL: '300',
          Urgency: 'high',
          Authorization: vapidAuthHeader(sub.endpoint, keys, subject)
        }
      },
      (res) => {
        res.resume()
        const status = res.statusCode || 0
        resolve({ status, gone: status === 404 || status === 410 })
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve({ status: 0, gone: false }))
    req.end(body)
  })
}
