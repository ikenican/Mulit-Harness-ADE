// iPhone 遠端控制 PWA 的 Service Worker：只負責 Web Push 通知與點擊後開到對應終端。
// 不做離線快取——App 本來就必須連得到桌面才有用，快取舊版反而會跟桌面協定對不上。

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { body: event.data ? event.data.text() : '' }
  }
  // iOS 規定每一則推播都必須顯示通知，否則會撤銷訂閱
  event.waitUntil(
    self.registration.showNotification(data.title || 'Agent Workbench', {
      body: data.body || '',
      tag: data.tag,
      renotify: true,
      icon: '/remote-icon-180.png',
      data: { url: data.url || '/' }
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        client.postMessage({ type: 'open', url })
        if ('focus' in client) return client.focus()
      }
      return self.clients.openWindow(url)
    })
  )
})
