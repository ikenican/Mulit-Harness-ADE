import { app, BrowserWindow, Notification } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as os from 'os'
import * as path from 'path'
import type { Socket } from 'net'
import simpleGit from 'simple-git'
import { WebSocketServer, WebSocket } from 'ws'
import { getAllProjectWindows } from '../index'
import {
  ptyEvents,
  listPtySessions,
  getPtySession,
  subscribePty,
  unsubscribePty,
  getPtyScrollback,
  writePty,
  resizePty,
  killPty,
  spawnPty,
  listLaunchers,
  type PtySessionInfo
} from '../ipc/pty'
import { isCliBypassPermissions, isCliEnabled } from '../ipc/settings'
import { stripAnsi } from '../../shared/approvalDetect'
import {
  BUILTIN_LAUNCHERS,
  type ClientMessage,
  type RemoteLauncher,
  type RemoteSession,
  type RemoteWindow,
  type ServerMessage
} from '../../shared/remoteProtocol'
import { certCovers, certDer, createCa, isPrivateIPv4, issueServerCert, lanAddresses, localHostname } from './certs'
import {
  addDevice,
  audit,
  findDeviceByToken,
  loadCerts,
  loadDevices,
  loadVapid,
  removeDevice,
  saveCerts,
  saveVapid,
  updateDevice,
  type DeviceRecord
} from './store'
import { generateVapidKeys, sendPush, type PushSubscriptionJSON, type VapidKeys } from './webpush'

// Remote Bridge：讓同一個區網的 iPhone 遠端操作桌面上的 CLI 終端。
//
//   https://<區網IP>:<port>      手機 PWA + WebSocket（/ws）+ 配對／推播 API
//   http://<區網IP>:<port+1>     只提供「安裝 CA 憑證」的設定頁，其餘一律導去 https
//
// 只接受私有網段來源；即使使用者在路由器上把 port 轉出去，外網連線也會在 TCP 層被斷開。

const PAIR_TTL_MS = 5 * 60 * 1000
const PAIR_MAX_FAILURES = 10
const PAIR_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' // 去掉易混淆的 0/O、1/I/L
const PUSH_SUBJECT = 'https://github.com/zkylek1212-k/Mulit-Harness-ADE'
const DIRECT_KEYS = new Set(BUILTIN_LAUNCHERS.map((l) => l.key))
// 只送推播到已知的推播服務，避免訂閱被拿來讓桌面對任意網址發請求
const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/]

function isPushEndpoint(endpoint: unknown): boolean {
  try {
    const u = new URL(String(endpoint))
    return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname))
  } catch {
    return false
  }
}

interface Client {
  connId: string
  ws: WebSocket
  device: DeviceRecord | null
  attached: Set<string>
  visible: boolean
}

export interface BridgeStatus {
  running: boolean
  port: number
  setupPort: number
  addresses: string[]
  hostName: string | null
  caFingerprint: string | null
  connectedDevices: string[]
  connectedDeviceIds: string[]
  error: string | null
}

function isAllowedRemote(addr?: string): boolean {
  if (!addr) return false
  const a = addr.replace(/^::ffff:/, '')
  return a === '127.0.0.1' || a === '::1' || isPrivateIPv4(a)
}

function guardLan(socket: Socket): void {
  if (!isAllowedRemote(socket.remoteAddress)) socket.destroy()
}

function readBody(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        reject(new Error('bad json'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'"
].join('; ')

/** 手機端靜態檔：打包後在 out/renderer（與桌面 renderer 同一個 Vite build 的第二個 entry） */
function staticRoot(): string {
  return path.join(__dirname, '../renderer')
}

function launcherKeyOf(s: PtySessionInfo): string {
  return s.launcherId || s.command
}

export class RemoteBridge {
  private server: https.Server | null = null
  private setupServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private clients = new Set<Client>()
  private port = 0
  private addresses: string[] = []
  private caCert: string | null = null
  private vapid: VapidKeys | null = null
  private pairing: { code: string; expiresAt: number; failures: number } | null = null
  private lastError: string | null = null
  private stateTimer: NodeJS.Timeout | null = null
  private pushThrottle = new Map<string, number>()
  private onStatus: () => void

  constructor(onStatus: () => void) {
    this.onStatus = onStatus
  }

  // —— 生命週期 ——

  async start(port: number): Promise<void> {
    await this.stop()
    this.port = port
    this.lastError = null
    try {
      const { certPem, keyPem } = this.ensureCerts()
      this.vapid = loadVapid()
      if (!this.vapid) {
        this.vapid = generateVapidKeys()
        saveVapid(this.vapid)
      }

      const server = https.createServer({ cert: certPem, key: keyPem, minVersion: 'TLSv1.2' }, (req, res) =>
        this.handleHttps(req, res).catch(() => {
          if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
        })
      )
      server.on('connection', guardLan)

      const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 })
      server.on('upgrade', (req, socket, head) => {
        const host = req.headers.host || ''
        // 擋跨站 WebSocket：只接受由本 PWA 自己的來源發起的連線
        if (req.url !== '/ws' || req.headers.origin !== `https://${host}`) {
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws))
      })

      const setup = http.createServer((req, res) => this.handleSetup(req, res))
      setup.on('connection', guardLan)

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '0.0.0.0', () => resolve())
      })
      await new Promise<void>((resolve, reject) => {
        setup.once('error', reject)
        setup.listen(port + 1, '0.0.0.0', () => resolve())
      })
      server.on('error', (e) => this.fail(e))
      setup.on('error', (e) => this.fail(e))

      this.server = server
      this.setupServer = setup
      this.wss = wss
      ptyEvents.on('changed', this.scheduleState)
      ptyEvents.on('approval', this.onApproval)
      ptyEvents.on('exit', this.onExit)
      ptyEvents.on('resized', this.onResized)
      audit('bridge.start', { port, addresses: this.addresses })
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e)
      await this.stop()
      this.lastError = this.lastError || 'failed to start'
      throw e
    } finally {
      this.onStatus()
    }
  }

  async stop(): Promise<void> {
    ptyEvents.off('changed', this.scheduleState)
    ptyEvents.off('approval', this.onApproval)
    ptyEvents.off('exit', this.onExit)
    ptyEvents.off('resized', this.onResized)
    for (const c of this.clients) this.dropClient(c, 1001)
    this.clients.clear()
    this.wss?.close()
    this.wss = null
    const closing = [this.server, this.setupServer].filter(Boolean).map(
      (s) =>
        new Promise<void>((resolve) => {
          s!.close(() => resolve())
          ;(s as any).closeAllConnections?.()
        })
    )
    this.server = null
    this.setupServer = null
    this.pairing = null
    await Promise.all(closing)
    this.onStatus()
  }

  private fail(e: Error): void {
    this.lastError = e.message
    this.onStatus()
  }

  get running(): boolean {
    return !!this.server
  }

  status(): BridgeStatus {
    return {
      running: this.running,
      port: this.port,
      setupPort: this.port + 1,
      addresses: this.running ? this.addresses : lanAddresses(),
      hostName: localHostname(),
      caFingerprint: this.caCertFingerprint(),
      connectedDevices: Array.from(new Set(this.authedClients().map((c) => c.device!.name))),
      connectedDeviceIds: Array.from(new Set(this.authedClients().map((c) => c.device!.id))),
      error: this.lastError
    }
  }

  private caCertFingerprint(): string | null {
    const pem = this.caCert || loadCerts()?.caCert
    return pem ? new crypto.X509Certificate(pem).fingerprint256 : null
  }

  private authedClients(): Client[] {
    return Array.from(this.clients).filter((c) => c.device)
  }

  /** CA 沿用舊的（手機不必重裝）；server 憑證在 IP 變動或快到期時重簽 */
  private ensureCerts(): { certPem: string; keyPem: string } {
    this.addresses = lanAddresses()
    const host = localHostname()
    const dns = host ? [host] : []
    let stored = loadCerts()
    if (!stored) {
      const ca = createCa(os.hostname().slice(0, 40))
      stored = { caCert: ca.certPem, caKey: ca.keyPem }
      audit('ca.created')
    }
    // 不放 127.0.0.1：CA 的 Name Constraints 只允許私有網段，手機也不會連 loopback
    const ips = this.addresses
    if (!stored.serverCert || !stored.serverKey || !certCovers(stored.serverCert, ips, dns)) {
      const leaf = issueServerCert({ certPem: stored.caCert, keyPem: stored.caKey }, ips, dns)
      stored = { ...stored, serverCert: leaf.certPem, serverKey: leaf.keyPem }
    }
    saveCerts(stored)
    this.caCert = stored.caCert
    return { certPem: stored.serverCert!, keyPem: stored.serverKey! }
  }

  // —— 配對 ——

  createPairingCode(): { code: string; expiresAt: number } {
    let code = ''
    const bytes = crypto.randomBytes(8)
    for (const b of bytes) code += PAIR_ALPHABET[b % PAIR_ALPHABET.length]
    this.pairing = { code, expiresAt: Date.now() + PAIR_TTL_MS, failures: 0 }
    return { code, expiresAt: this.pairing.expiresAt }
  }

  private tryPair(rawCode: string, name: string): { token: string; deviceId: string } | null {
    const p = this.pairing
    if (!p || Date.now() > p.expiresAt) return null
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    const ok = code.length === p.code.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(p.code))
    if (!ok) {
      p.failures++
      if (p.failures >= PAIR_MAX_FAILURES) this.pairing = null
      audit('pair.fail', { failures: p.failures })
      return null
    }
    this.pairing = null // 一次性
    const { device, token } = addDevice(String(name || 'iPhone'))
    audit('pair.ok', { deviceId: device.id, name: device.name })
    if (Notification.isSupported()) {
      new Notification({ title: 'Remote control', body: `「${device.name}」已配對，可以遠端操作終端` }).show()
    }
    this.onStatus()
    return { token, deviceId: device.id }
  }

  revokeDevice(id: string): void {
    removeDevice(id)
    for (const c of this.clients) if (c.device?.id === id) this.dropClient(c, 4001)
    audit('device.revoke', { deviceId: id })
    this.onStatus()
  }

  // —— HTTP ——

  private authDevice(req: http.IncomingMessage): DeviceRecord | null {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '')
    return m ? findDeviceByToken(m[1]) : null
  }

  private async handleHttps(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'https://localhost')
    const p = url.pathname

    if (p === '/api/pair' && req.method === 'POST') {
      const body = await readBody(req)
      const result = this.tryPair(body.code, body.name)
      return result ? sendJson(res, 200, result) : sendJson(res, 403, { error: 'invalid or expired code' })
    }
    if (p === '/api/vapid' && req.method === 'GET') {
      if (!this.authDevice(req)) return sendJson(res, 401, { error: 'unauthorized' })
      return sendJson(res, 200, { publicKey: this.vapid?.publicKey })
    }
    if (p === '/api/push' && req.method === 'POST') {
      const device = this.authDevice(req)
      if (!device) return sendJson(res, 401, { error: 'unauthorized' })
      const body = await readBody(req)
      const sub = body.subscription as PushSubscriptionJSON | null
      if (sub && (!isPushEndpoint(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth)) {
        return sendJson(res, 400, { error: 'bad subscription' })
      }
      updateDevice(device.id, { push: sub || undefined })
      audit(sub ? 'push.subscribe' : 'push.unsubscribe', { deviceId: device.id })
      if (sub && body.test && this.vapid) {
        await sendPush(sub, { title: 'Agent Workbench', body: '通知已開啟 ✓', tag: 'test' }, this.vapid, PUSH_SUBJECT)
      }
      this.onStatus()
      return sendJson(res, 200, { ok: true })
    }
    if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' })

    return this.serveStatic(p, res)
  }

  private serveStatic(p: string, res: http.ServerResponse): void {
    const root = staticRoot()
    let rel: string | null = null
    if (p === '/' || p === '/index.html') rel = 'remote.html'
    else if (/^\/assets\/[\w.-]+$/.test(p)) rel = p.slice(1)
    else if (/^\/remote-[\w.-]+$/.test(p)) rel = p.slice(1)

    const file = rel ? path.join(root, rel) : null
    if (!file || !fs.existsSync(file)) {
      if (p === '/' || p === '/index.html') {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Mobile client not built. Run `npm run build` once, then restart the app.')
        return
      }
      res.writeHead(404)
      res.end()
      return
    }
    const ext = path.extname(file)
    const headers: Record<string, string> = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': CSP,
      // Vite 產出的 assets 檔名帶 hash，可以長快取；其他（html / sw / manifest）一律重抓
      'Cache-Control': rel!.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    }
    if (rel === 'remote-sw.js') headers['Service-Worker-Allowed'] = '/'
    res.writeHead(200, headers)
    fs.createReadStream(file).pipe(res)
  }

  /** http 設定頁：iPhone 還沒信任 CA 前唯一能打開的頁面 */
  private handleSetup(req: http.IncomingMessage, res: http.ServerResponse): void {
    const p = new URL(req.url || '/', 'http://localhost').pathname
    const host = (req.headers.host || '').split(':')[0]
    const appUrl = `https://${host}:${this.port}/`
    if (p === '/ca.crt' && this.caCert) {
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="AgentWorkbench-LocalCA.crt"',
        'Cache-Control': 'no-store'
      })
      res.end(certDer(this.caCert))
      return
    }
    if (p !== '/') {
      res.writeHead(302, { Location: appUrl })
      res.end()
      return
    }
    const fp = this.caCert ? new crypto.X509Certificate(this.caCert).fingerprint256 : ''
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(setupPage(appUrl, fp))
  }

  // —— WebSocket ——

  private onConnection(ws: WebSocket): void {
    const client: Client = { connId: crypto.randomUUID(), ws, device: null, attached: new Set(), visible: true }
    this.clients.add(client)
    // 5 秒內沒通過驗證就斷線
    const authTimer = setTimeout(() => {
      if (!client.device) this.dropClient(client, 4001)
    }, 5000)

    ws.on('message', (raw) => {
      let msg: ClientMessage
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!client.device) {
        if (msg.t !== 'auth') return this.dropClient(client, 4001)
        const device = findDeviceByToken(msg.token)
        if (!device) return this.dropClient(client, 4001)
        clearTimeout(authTimer)
        client.device = device
        updateDevice(device.id, { lastSeenAt: Date.now() })
        audit('device.connect', { deviceId: device.id })
        this.send(client, { t: 'authed', deviceId: device.id, deviceName: device.name, hostName: os.hostname() })
        this.send(client, this.buildState())
        this.onStatus()
        return
      }
      this.handleMessage(client, msg).catch((e) =>
        this.send(client, { t: 'error', message: e instanceof Error ? e.message : String(e) })
      )
    })
    ws.on('close', () => {
      clearTimeout(authTimer)
      for (const id of client.attached) unsubscribePty(id, `remote:${client.connId}`)
      this.clients.delete(client)
      if (client.device) {
        updateDevice(client.device.id, { lastSeenAt: Date.now() })
        audit('device.disconnect', { deviceId: client.device.id })
      }
      this.onStatus()
    })
    ws.on('error', () => this.dropClient(client, 1011))
  }

  private dropClient(c: Client, code: number): void {
    try {
      c.ws.close(code)
    } catch {
      // ignore
    }
    setTimeout(() => c.ws.terminate(), 1000)
  }

  private send(c: Client, msg: ServerMessage): void {
    if (c.ws.readyState !== WebSocket.OPEN) return
    // 手機網路卡住、堆積超過 8MB 就斷線，讓它重連後重新拿 snapshot，避免吃光記憶體
    if (c.ws.bufferedAmount > 8 * 1024 * 1024) return this.dropClient(c, 1013)
    c.ws.send(JSON.stringify(msg))
  }

  private broadcast(msg: ServerMessage, filter?: (c: Client) => boolean): void {
    for (const c of this.clients) if (c.device && (!filter || filter(c))) this.send(c, msg)
  }

  private async handleMessage(c: Client, msg: ClientMessage): Promise<void> {
    const subKey = `remote:${c.connId}`
    switch (msg.t) {
      case 'ping':
        return this.send(c, { t: 'pong' })
      case 'visibility':
        c.visible = !!msg.visible
        return
      case 'attach': {
        const info = getPtySession(msg.id)
        const snapshot = subscribePty(msg.id, subKey, {
          data: (id, d) => this.send(c, { t: 'data', id, d }),
          exit: () => {
            c.attached.delete(msg.id)
          }
        })
        if (snapshot === null || !info) return this.send(c, { t: 'error', message: 'session not found' })
        c.attached.add(msg.id)
        return this.send(c, { t: 'snapshot', id: msg.id, data: snapshot, cols: info.cols, rows: info.rows })
      }
      case 'detach':
        unsubscribePty(msg.id, subKey)
        c.attached.delete(msg.id)
        return
      case 'input':
        if (typeof msg.data === 'string' && msg.data.length <= 64 * 1024) writePty(msg.id, msg.data)
        return
      case 'resize':
        resizePty(msg.id, Math.min(500, Math.max(10, msg.cols | 0)), Math.min(200, Math.max(5, msg.rows | 0)))
        return
      case 'kill':
        audit('session.kill', { deviceId: c.device?.id, session: msg.id })
        return killPty(msg.id)
      case 'spawn': {
        const win = BrowserWindow.fromId(msg.windowId)
        const entry = getAllProjectWindows().find((e) => e.window === win)
        if (!win || !entry) return this.send(c, { t: 'error', message: 'window not found' })
        const launcher = this.launchersFor(entry.workspaceRoot).find((l) => l.key === msg.launcherKey)
        if (!launcher) return this.send(c, { t: 'error', message: 'launcher not available' })
        const id = spawnPty(
          {
            ...(DIRECT_KEYS.has(launcher.key) ? { command: launcher.key } : { launcherId: launcher.key }),
            title: launcher.title,
            cols: 120,
            rows: 34
          },
          { workspace: entry.workspaceRoot, owner: win.webContents, subscribeOwner: false }
        )
        // 桌面上也開一個分頁接上同一個 pty：手機開的 agent 在電腦前也看得到、接得手
        win.webContents.send('pty:remoteSpawned', { ptyId: id, launcherKey: launcher.key, title: launcher.title })
        audit('session.spawn', { deviceId: c.device?.id, launcher: launcher.key, workspace: entry.workspaceRoot })
        return this.send(c, { t: 'spawned', id })
      }
      case 'handoff': {
        const ws = this.workspaceOf(msg.windowId)
        let text: string | null = null
        if (ws) {
          try {
            const f = path.join(ws, '.project-memory', 'handoff.md')
            text = fs.readFileSync(f, 'utf8').slice(0, 200_000)
          } catch {
            text = null
          }
        }
        return this.send(c, { t: 'handoff', windowId: msg.windowId, text })
      }
      case 'git': {
        const ws = this.workspaceOf(msg.windowId)
        if (!ws) return this.send(c, { t: 'git', windowId: msg.windowId, branch: null, ahead: 0, behind: 0, files: [], error: 'no workspace' })
        try {
          const st = await simpleGit(ws).status()
          return this.send(c, {
            t: 'git',
            windowId: msg.windowId,
            branch: st.current,
            ahead: st.ahead,
            behind: st.behind,
            files: st.files.slice(0, 500).map((f) => ({ path: f.path, index: f.index, workingDir: f.working_dir }))
          })
        } catch (e) {
          return this.send(c, {
            t: 'git',
            windowId: msg.windowId,
            branch: null,
            ahead: 0,
            behind: 0,
            files: [],
            error: e instanceof Error ? e.message : String(e)
          })
        }
      }
    }
  }

  private workspaceOf(windowId: number): string | null {
    return getAllProjectWindows().find((e) => e.window.id === windowId)?.workspaceRoot || null
  }

  private launchersFor(ws: string): RemoteLauncher[] {
    const builtin = BUILTIN_LAUNCHERS.filter((l) => isCliEnabled(l.key))
    const custom: RemoteLauncher[] = ws
      ? listLaunchers(ws).map((l) => ({ key: l.id, title: l.name, kind: 'custom' as const }))
      : []
    return [...builtin, ...custom]
  }

  private buildState(): ServerMessage {
    const windows = getAllProjectWindows()
    const byWc = new Map(windows.map((e) => [e.window.webContents.id, e]))
    const sessions: RemoteSession[] = listPtySessions()
      .filter((s) => byWc.has(s.ownerId))
      .map((s) => ({
        id: s.id,
        title: s.title,
        launcherKey: launcherKeyOf(s),
        windowId: byWc.get(s.ownerId)!.window.id,
        workspaceName: path.basename(s.workspace || '') || '~',
        startTime: s.startTime,
        cols: s.cols,
        rows: s.rows,
        needsApproval: s.needsApproval,
        lastOutputAt: s.lastOutputAt
      }))
    const remoteWindows: RemoteWindow[] = windows.map((e) => ({
      id: e.window.id,
      workspace: e.workspaceRoot,
      workspaceName: path.basename(e.workspaceRoot || '') || '(no folder)',
      launchers: this.launchersFor(e.workspaceRoot)
    }))
    return { t: 'state', sessions, windows: remoteWindows, bypass: isCliBypassPermissions() }
  }

  // arrow function：當成事件 listener 註冊／移除時 this 不會跑掉
  private scheduleState = (): void => {
    if (this.stateTimer) return
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      if (this.clients.size) this.broadcast(this.buildState())
    }, 150)
  }

  private onResized = (id: string, cols: number, rows: number): void => {
    this.broadcast({ t: 'resized', id, cols, rows }, (c) => c.attached.has(id))
  }

  private onApproval = (id: string): void => {
    const s = getPtySession(id)
    if (!s) return
    // 提示通常在最後幾行：去掉 ANSI 後給手機顯示在審批卡片上
    const tail = stripAnsi((getPtyScrollback(id) || '').slice(-3000))
    this.broadcast({ t: 'approval', id, title: s.title, tail })
    this.push(id, 'approval', {
      title: `⏳ ${s.title} 等待你的回覆`,
      body: `${path.basename(s.workspace || '')} · ${lastLines(tail, 2) || 'Approval needed'}`,
      tag: `approval-${id}`,
      url: `/#s=${id}`
    })
  }

  private onExit = (id: string, code: number, title: string, killed: boolean): void => {
    this.broadcast({ t: 'exit', id, code, title })
    // 使用者自己關掉的終端不用通知
    if (killed) return
    this.push(id, 'exit', { title: `✓ ${title} 已結束`, body: `exit code ${code}`, tag: `exit-${id}`, url: '/' })
  }

  /** 前景開著 App 的裝置直接用 WebSocket 看到就好；其他已訂閱的裝置送 Web Push */
  private push(id: string, kind: string, payload: object): void {
    const vapid = this.vapid
    if (!vapid) return
    const key = `${kind}:${id}`
    const now = Date.now()
    if (now - (this.pushThrottle.get(key) || 0) < 20_000) return
    this.pushThrottle.set(key, now)

    const foreground = new Set(
      Array.from(this.clients)
        .filter((c) => c.device && c.visible)
        .map((c) => c.device!.id)
    )
    for (const d of loadDevices()) {
      if (!d.push || foreground.has(d.id)) continue
      sendPush(d.push, payload, vapid, PUSH_SUBJECT).then((r) => {
        if (r.gone) {
          updateDevice(d.id, { push: undefined })
          audit('push.gone', { deviceId: d.id, status: r.status })
        }
      })
    }
  }
}

function lastLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' · ')
    .slice(0, 160)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)
}

function setupPage(appUrl: string, fingerprint: string): string {
  const name = escapeHtml(app.getName() || 'Agent Workbench')
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name} · iPhone 設定</title>
<style>
:root{color-scheme:light dark;--bg:#f5f5f7;--card:#fff;--fg:#1d1d1f;--mut:#6e6e73;--acc:#0a84ff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--fg:#f5f5f7;--mut:#98989d}}
body{margin:0;padding:24px 16px 48px;font:16px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
h1{font-size:24px;margin:8px 0 4px}p{color:var(--mut);margin:4px 0 16px}
ol{list-style:none;padding:0;margin:0;display:grid;gap:12px}
li{background:var(--card);border-radius:14px;padding:16px}
b{display:block;margin-bottom:4px}.btn{display:block;text-align:center;background:var(--acc);color:#fff;text-decoration:none;border-radius:12px;padding:12px;margin-top:10px;font-weight:600}
code{font-size:11px;word-break:break-all;color:var(--mut)}
</style></head><body>
<h1>用 iPhone 遠端控制</h1>
<p>第一次使用需要讓 iPhone 信任這台電腦的本機憑證（只能用在區網位址）。</p>
<ol>
<li><b>1. 下載憑證</b>用 Safari 開啟此頁並點下方按鈕，選「允許」。<a class="btn" href="/ca.crt">下載描述檔</a></li>
<li><b>2. 安裝描述檔</b>設定 → 一般 → VPN 與裝置管理 → 選「Agent Workbench Local CA」→ 安裝。</li>
<li><b>3. 開啟完全信任</b>設定 → 一般 → 關於本機 → 憑證信任設定 → 打開「Agent Workbench Local CA」。</li>
<li><b>4. 開啟 App</b>用 Safari 開啟下方連結 → 分享 → 加入主畫面，再從主畫面開啟並輸入桌面上顯示的配對碼。<a class="btn" href="${escapeHtml(appUrl)}">開啟 ${escapeHtml(appUrl)}</a></li>
</ol>
<p style="margin-top:20px">核對憑證指紋（SHA-256，需與桌面設定頁一致）：<br><code>${escapeHtml(fingerprint)}</code></p>
</body></html>`
}
