import type { PairResponse } from '../../shared/remoteProtocol'

// 手機端的本機狀態與 HTTP API（配對、推播訂閱）。
// 注意：iOS「加入主畫面」後的 App 與 Safari 分頁不共用 localStorage，
// 所以配對一定要在主畫面開啟的 App 裡再做一次（配對碼輸入畫面就是為此存在）。

const TOKEN_KEY = 'aw.remote.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // 私密瀏覽等情況寫不進去，就每次重新配對
  }
}

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

export async function pair(code: string, name: string): Promise<PairResponse> {
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, name })
  })
  if (!res.ok) throw new Error(res.status === 403 ? 'invalid' : `HTTP ${res.status}`)
  return (await res.json()) as PairResponse
}

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/remote-sw.js', { scope: '/' })
  } catch {
    return null
  }
}

export async function pushState(): Promise<'unsupported' | 'denied' | 'on' | 'off'> {
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/** 必須由使用者點擊觸發（iOS 規定），且只在主畫面 App 裡可用 */
export async function enablePush(token: string): Promise<void> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('denied')
  const reg = (await registerServiceWorker()) || (await navigator.serviceWorker.ready)
  const keyRes = await fetch('/api/vapid', { headers: { Authorization: `Bearer ${token}` } })
  if (!keyRes.ok) throw new Error(`HTTP ${keyRes.status}`)
  const { publicKey } = (await keyRes.json()) as { publicKey: string }
  const existing = await reg.pushManager.getSubscription()
  const sub =
    existing ||
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) }))
  await savePushSubscription(token, sub.toJSON(), true)
}

export async function disablePush(token: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  await sub?.unsubscribe()
  await savePushSubscription(token, null, false)
}

async function savePushSubscription(token: string, subscription: PushSubscriptionJSON | null, test: boolean): Promise<void> {
  const res = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ subscription, test })
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}
