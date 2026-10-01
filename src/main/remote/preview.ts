import * as crypto from 'crypto'
import * as http from 'http'
import * as https from 'https'
import type { Socket } from 'net'

// 手機預覽：把桌面上某個終端印出的 dev server（http://localhost:PORT）
// 經由一台 https 反向代理送到手機。
//
// 為什麼一定要代理，不能讓手機直接連：
//   1. 手機的 localhost 是手機自己，不是你的電腦；
//   2. dev server 多半只綁 127.0.0.1，區網連不到；
//   3. 手機 PWA 是 https，iframe 裡放 http 會被 mixed-content 擋掉。
//
// 為什麼要自己一個 port 而不是掛在 PWA 那台的路徑下：
//   被預覽的頁面裡到處都是 `/assets/x.js` 這種根目錄相對路徑。掛在 /preview/<port>/
//   底下的話，這些請求會跑回 bridge 的根目錄、和 PWA 自己的檔案撞在一起。
//   給它自己一個 origin，相對路徑就自然對了，不必改寫 HTML。
//
// 存取控制：
//   - 只接受私有網段來源（與 bridge 同一個 guard）；
//   - 第一次進來必須帶「一次性 ticket」（由已認證的 WebSocket 發給手機），
//     換成一個 HttpOnly cookie，之後的請求靠 cookie；
//   - 目標 port 必須是「目前某個終端真的印出來過」的，且一律只連 127.0.0.1。
//   這樣才不會把一台只綁 loopback 的 dev server 無條件曝露到區網。

const TICKET_TTL_MS = 60_000
const COOKIE = 'aw_preview'
const AUTH_PATH = '/__aw'

function cookieOf(header: string | undefined, name: string): string | null {
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

export class PreviewProxy {
  private server: https.Server | null = null
  private port = 0
  private key = crypto.randomBytes(32)
  private tickets = new Map<string, { port: number; expiresAt: number }>()
  private allowPort: (port: number) => boolean

  /** allowPort：問呼叫端這個 port 現在還算不算「某個終端印出來的」 */
  constructor(allowPort: (port: number) => boolean) {
    this.allowPort = allowPort
  }

  get running(): boolean {
    return !!this.server
  }

  get listenPort(): number {
    return this.running ? this.port : 0
  }

  /** 起不來不是致命錯誤：預覽沒了，但遠端控制本身要照常跑 */
  async start(port: number, certPem: string, keyPem: string, guard: (s: Socket) => void): Promise<void> {
    await this.stop()
    this.port = port
    this.key = crypto.randomBytes(32)
    const server = https.createServer({ cert: certPem, key: keyPem, minVersion: 'TLSv1.2' }, (req, res) =>
      this.onRequest(req, res)
    )
    server.on('connection', guard)
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket as Socket, head))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '0.0.0.0', () => resolve())
    })
    server.on('error', () => {})
    this.server = server
  }

  async stop(): Promise<void> {
    const s = this.server
    this.server = null
    this.tickets.clear()
    if (!s) return
    await new Promise<void>((resolve) => {
      s.close(() => resolve())
      ;(s as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
    })
  }

  /** 發一張一次性 ticket，回傳手機要開的網址；host 用手機連進來時用的那個位址 */
  issueUrl(host: string, devPort: number): string | null {
    if (!this.server || !this.allowPort(devPort)) return null
    const ticket = crypto.randomBytes(24).toString('base64url')
    this.tickets.set(ticket, { port: devPort, expiresAt: Date.now() + TICKET_TTL_MS })
    // 順手清掉過期的，這張表不該長大
    for (const [k, v] of this.tickets) if (v.expiresAt < Date.now()) this.tickets.delete(k)
    return `https://${host}:${this.port}${AUTH_PATH}?t=${ticket}`
  }

  private sign(port: number): string {
    return crypto.createHmac('sha256', this.key).update(String(port)).digest('base64url')
  }

  /** cookie 自己帶著 port + 簽章，伺服器端不必再存一張表 */
  private portFromCookie(header: string | undefined): number | null {
    const raw = cookieOf(header, COOKIE)
    if (!raw) return null
    const dot = raw.lastIndexOf('.')
    if (dot <= 0) return null
    const port = Number(raw.slice(0, dot))
    const sig = raw.slice(dot + 1)
    if (!Number.isInteger(port)) return null
    const expect = Buffer.from(this.sign(port))
    const got = Buffer.from(sig)
    if (expect.length !== got.length || !crypto.timingSafeEqual(expect, got)) return null
    return this.allowPort(port) ? port : null
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || '/', 'https://localhost')
    if (url.pathname === AUTH_PATH) {
      const ticket = url.searchParams.get('t') || ''
      const grant = this.tickets.get(ticket)
      this.tickets.delete(ticket) // 一次性
      if (!grant || grant.expiresAt < Date.now() || !this.allowPort(grant.port)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end('preview link expired — reopen Preview in the app')
        return
      }
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE}=${grant.port}.${this.sign(grant.port)}; Path=/; Secure; HttpOnly; SameSite=Lax`,
        Location: '/',
        'Cache-Control': 'no-store'
      })
      res.end()
      return
    }

    const port = this.portFromCookie(req.headers.cookie)
    if (!port) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('no preview session')
      return
    }

    const headers = { ...req.headers, host: `127.0.0.1:${port}` }
    delete headers.cookie // 我們的 cookie 不要外流給被預覽的程式
    delete headers['accept-encoding'] // 不壓縮，代理簡單一點
    const upstream = http.request(
      { host: '127.0.0.1', port, method: req.method, path: req.url, headers },
      (up) => {
        const out = { ...up.headers }
        // 這個頁面要能被手機 App 的 iframe 框住
        delete out['x-frame-options']
        res.writeHead(up.statusCode || 502, out)
        up.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('dev server not reachable')
    })
    req.pipe(upstream)
  }

  /** HMR 的 WebSocket：原樣轉給 dev server，不然 Vite 會一直重連並蓋錯誤畫面 */
  private onUpgrade(req: http.IncomingMessage, socket: Socket, head: Buffer): void {
    const port = this.portFromCookie(req.headers.cookie)
    if (!port) return void socket.destroy()
    const headers = { ...req.headers, host: `127.0.0.1:${port}` }
    delete headers.cookie
    const upstream = http.request({ host: '127.0.0.1', port, method: 'GET', path: req.url, headers })
    upstream.on('upgrade', (upRes, upSocket, upHead) => {
      const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
      for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
        lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`)
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (upHead?.length) socket.write(upHead)
      if (head?.length) upSocket.write(head)
      upSocket.on('error', () => socket.destroy())
      socket.on('error', () => upSocket.destroy())
      upSocket.pipe(socket)
      socket.pipe(upSocket)
    })
    upstream.on('error', () => socket.destroy())
    upstream.on('response', () => socket.destroy()) // dev server 不接受升級
    upstream.end()
  }
}
