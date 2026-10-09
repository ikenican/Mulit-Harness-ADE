// 手機端的推播訂閱（HTTP API）。
//
// token 與「記住的電腦」在 ./hosts.ts；配對走 WebSocket（./conn.ts 的 pairOverWs），
// 因為要配對的可能是另一台電腦，跨 origin 的 fetch 會被 CORS 擋掉。
//
// 這裡的 /api/* 一律是「這個頁面的 origin」，也就是送來這個 App 的那台電腦：
// 推播訂閱綁在 origin 的 Service Worker 上，只有它推得到這支手機。
// 注意：iOS「加入主畫面」後的 App 與 Safari 分頁不共用 localStorage，
// 所以配對一定要在主畫面開啟的 App 裡再做一次（配對碼輸入畫面就是為此存在）。

export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
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
