// 自我檢查：npx tsx scripts/check-hosts.mts
// 驗證手機端「記住的電腦」：位址解析、最多 3 台、每台各自的 token、切換目標。
import assert from 'node:assert'

// hosts.ts 只用到 localStorage 與 location，這裡給最小的假物件就能在 node 下驗
const store = new Map<string, string>()
const g = globalThis as unknown as { localStorage: unknown; location: { host: string } }
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}
g.location = { host: '192.168.1.5:47600' }

const h = await import('../src/renderer/remote/hosts.ts')
const HERE = 'https://192.168.1.5:47600/'

// —— 位址解析：只打 IP 也要能用 ——
assert.equal(h.parseHostInput('192.168.1.6'), 'https://192.168.1.6:47600/')
assert.equal(h.parseHostInput('192.168.1.6:47700'), 'https://192.168.1.6:47700/')
assert.equal(h.parseHostInput('https://192.168.1.6:47700/'), 'https://192.168.1.6:47700/')
assert.equal(h.parseHostInput('http://192.168.1.6:47700'), 'https://192.168.1.6:47700/') // 一律 https
assert.equal(h.parseHostInput('  '), '')
assert.equal(h.parseHostInput('not a host'), '')

// —— 這台電腦永遠在清單裡（App 是它送來的） ——
assert.equal(h.currentUrl(), HERE)
assert.deepEqual(h.loadHosts(), [{ url: HERE, label: '192.168.1.5:47600' }])
assert.equal(h.activeUrl(), HERE)

// —— 加入與改名 ——
h.addHost(HERE, 'Desk PC')
assert.equal(h.loadHosts()[0].label, 'Desk PC')
h.addHost('https://192.168.1.6:47600/', 'Laptop')
h.addHost('https://192.168.1.6:47600', 'Laptop 14') // 少斜線是同一台
assert.deepEqual(
  h.loadHosts().map((x) => x.label),
  ['Desk PC', 'Laptop 14']
)

// —— 上限 3 台，第 4 台回 null，不擠掉既有的 ——
h.addHost('https://192.168.1.7:47600/', 'Studio')
assert.equal(h.hostsFull(), true)
assert.equal(h.addHost('https://192.168.1.8:47600/', 'Fourth'), null)
assert.equal(h.loadHosts().length, 3)

// —— token 每台一份，互不影響 ——
h.setToken(HERE, 'token-a')
h.setToken('https://192.168.1.6:47600/', 'token-b')
assert.equal(h.getToken(HERE), 'token-a')
assert.equal(h.getToken('https://192.168.1.6:47600/'), 'token-b')
assert.equal(h.getToken('https://192.168.1.7:47600/'), null)

// —— 切換目標 ——
assert.equal(h.setActiveUrl('https://192.168.1.6:47600/'), 'https://192.168.1.6:47600/')
assert.equal(h.activeUrl(), 'https://192.168.1.6:47600/')

// —— 移除：連 token 一起忘掉，而且不能留在「正在連」的狀態 ——
h.removeHost('https://192.168.1.6:47600/')
assert.equal(h.getToken('https://192.168.1.6:47600/'), null)
assert.equal(h.loadHosts().length, 2)
assert.notEqual(h.activeUrl(), 'https://192.168.1.6:47600/')
// 沒記住的電腦不能被選成連線目標
assert.equal(h.setActiveUrl('https://10.0.0.9:47600/') && h.activeUrl(), HERE)

// —— 舊版的單一 token 要搬到新的表，不能讓人重新配對 ——
store.clear()
store.set('aw.remote.token', JSON.stringify('legacy')) // 舊版存的是原字串，見下
store.set('aw.remote.token', 'legacy-plain')
assert.equal(h.getToken(HERE), 'legacy-plain')
assert.equal(store.has('aw.remote.token'), false, '搬完就該清掉舊鍵')

// —— 憑證安裝頁是 port + 1 ——
assert.equal(h.setupUrlFor('https://192.168.1.6:47600/'), 'http://192.168.1.6:47601/')

console.log('hosts ok')
