// Dashboard 掃描的 worker thread（dashboard.ts 以 ?nodeWorker 建立）。
// 一次處理一則訊息、依送達順序：先送的 invalidate 一定在後面的 scan 之前生效。
import { parentPort, workerData } from 'worker_threads'
import { invalidateSessionCache, scanDashboard, setScanContext } from './sessionScan'
import { scanAllUsage, setUsageDataDir } from './usage'

let known: string[] = []
setScanContext({ dataDir: workerData.dataDir, knownWorkspaces: () => known })
setUsageDataDir(workerData.dataDir)

parentPort!.on('message', (m: { type: string; id?: number; enabled?: { claude: boolean; codex: boolean }; known?: string[] }) => {
  if (m.type === 'invalidate') {
    invalidateSessionCache()
    return
  }
  try {
    if (m.type === 'scan') {
      known = Array.isArray(m.known) ? m.known : []
      parentPort!.postMessage({ id: m.id, ok: true, value: scanDashboard({ claude: !!m.enabled?.claude, codex: !!m.enabled?.codex }) })
    } else if (m.type === 'usage') {
      parentPort!.postMessage({ id: m.id, ok: true, value: scanAllUsage() })
    } else {
      parentPort!.postMessage({ id: m.id, ok: false, error: `unknown message ${m.type}` })
    }
  } catch (e) {
    parentPort!.postMessage({ id: m.id, ok: false, error: (e as Error)?.message || String(e) })
  }
})
