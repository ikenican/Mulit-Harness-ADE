import type { ClientMessage, ServerMessage } from '../../shared/remoteProtocol'

// 與桌面 Remote Bridge 的 WebSocket 連線。iOS 把 App 切到背景時連線一定會斷，
// 所以這裡的重點是「回到前景立刻重連、重新 attach 目前的終端」。

export type ConnState = 'connecting' | 'open' | 'closed' | 'unauthorized'

export class RemoteConnection {
  private ws: WebSocket | null = null
  private retry = 0
  private timer: number | null = null
  private pingTimer: number | null = null
  private stopped = false
  private listeners = new Set<(m: ServerMessage) => void>()
  private stateListeners = new Set<(s: ConnState) => void>()
  state: ConnState = 'closed'

  constructor(private token: string) {}

  start(): void {
    this.stopped = false
    this.connect()
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  stop(): void {
    this.stopped = true
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.clearTimers()
    this.ws?.close()
    this.ws = null
  }

  onMessage(cb: (m: ServerMessage) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onState(cb: (s: ConnState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private setState(s: ConnState): void {
    this.state = s
    for (const cb of this.stateListeners) cb(s)
  }

  private clearTimers(): void {
    if (this.timer) window.clearTimeout(this.timer)
    if (this.pingTimer) window.clearInterval(this.pingTimer)
    this.timer = null
    this.pingTimer = null
  }

  private connect(): void {
    if (this.stopped) return
    this.clearTimers()
    this.setState('connecting')
    const ws = new WebSocket(`wss://${location.host}/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      ws.send(JSON.stringify({ t: 'auth', token: this.token }))
      // 25 秒一次心跳，讓 NAT／Wi-Fi 省電模式不要把閒置連線收掉
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping' }), 25_000)
    }
    ws.onmessage = (ev) => {
      let msg: ServerMessage
      try {
        msg = JSON.parse(ev.data as string)
      } catch {
        return
      }
      if (msg.t === 'authed') {
        this.setState('open')
        this.send({ t: 'visibility', visible: document.visibilityState === 'visible' })
      }
      for (const cb of this.listeners) cb(msg)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      this.clearTimers()
      if (ev.code === 4001) {
        this.setState('unauthorized')
        return
      }
      this.setState('closed')
      this.schedule()
    }
  }

  private schedule(): void {
    if (this.stopped || document.visibilityState !== 'visible') return
    const delay = Math.min(5000, 400 * 2 ** this.retry++)
    this.timer = window.setTimeout(() => this.connect(), delay)
  }

  private onVisibility = (): void => {
    const visible = document.visibilityState === 'visible'
    if (visible && !this.ws) {
      this.retry = 0
      this.connect()
    } else {
      this.send({ t: 'visibility', visible })
    }
  }
}
