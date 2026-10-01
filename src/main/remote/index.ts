import { ipcMain, BrowserWindow } from 'electron'
import QRCode from 'qrcode'
import { RemoteBridge, type BridgeStatus } from './server'
import { audit, loadConfig, loadDevices, resetAll, saveConfig } from './store'
import type { RemoteDeviceInfo, RemotePairingInfo, RemoteStatus } from '../../preload/index'

// 遠端控制的 IPC：設定頁的開關、配對碼、裝置清單。實際伺服器在 ./server.ts。

let bridge: RemoteBridge | null = null

function broadcastStatus(): void {
  const status = getStatus()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('remote:status', status)
  }
}

function getStatus(): RemoteStatus {
  const cfg = loadConfig()
  const s: BridgeStatus = bridge!.status()
  const primary = s.addresses[0] || null
  return {
    enabled: cfg.enabled,
    running: s.running,
    port: cfg.port,
    addresses: s.addresses,
    appUrl: primary ? `https://${primary}:${cfg.port}/` : null,
    setupUrl: primary ? `http://${primary}:${cfg.port + 1}/` : null,
    caFingerprint: s.caFingerprint,
    connectedDevices: s.connectedDevices,
    error: s.error
  }
}

async function applyEnabled(): Promise<void> {
  const cfg = loadConfig()
  if (cfg.enabled) {
    try {
      await bridge!.start(cfg.port)
    } catch (e) {
      console.error('[Remote] failed to start bridge:', e)
    }
  } else {
    await bridge!.stop()
  }
}

export function registerRemoteHandlers(): void {
  bridge = new RemoteBridge(broadcastStatus)

  ipcMain.handle('remote:status', () => getStatus())

  ipcMain.handle('remote:setEnabled', async (_e, enabled: boolean) => {
    saveConfig({ enabled: !!enabled })
    audit(enabled ? 'bridge.enable' : 'bridge.disable')
    await applyEnabled()
    return getStatus()
  })

  ipcMain.handle('remote:setPort', async (_e, port: number) => {
    saveConfig({ port })
    await applyEnabled()
    return getStatus()
  })

  ipcMain.handle('remote:qr', async (_e, text: string) => {
    return QRCode.toDataURL(String(text).slice(0, 500), { margin: 1, width: 360 })
  })

  ipcMain.handle('remote:createPairing', async (_e, requestedAddress?: string): Promise<RemotePairingInfo | null> => {
    if (!bridge!.running) return null
    const status = bridge!.status()
    const address = status.addresses.includes(requestedAddress || '') ? requestedAddress : status.addresses[0]
    if (!address) return null
    const { code, expiresAt } = bridge!.createPairingCode()
    const pairUrl = `https://${address}:${status.port}/#pair=${code}`
    return {
      code,
      expiresAt,
      pairUrl,
      pairQr: pairUrl ? await QRCode.toDataURL(pairUrl, { margin: 1, width: 360 }) : null
    }
  })

  ipcMain.handle('remote:devices', (): RemoteDeviceInfo[] => {
    const online = new Set(bridge!.status().connectedDeviceIds)
    return loadDevices().map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: d.lastSeenAt,
      pushEnabled: !!d.push,
      online: online.has(d.id)
    }))
  })

  ipcMain.handle('remote:revokeDevice', (_e, id: string) => {
    bridge!.revokeDevice(id)
    return true
  })

  // 重設信任：換一張新 CA、清掉所有裝置。懷疑手機遺失或憑證外洩時用
  ipcMain.handle('remote:resetTrust', async () => {
    await bridge!.stop()
    resetAll()
    audit('trust.reset')
    await applyEnabled()
    return getStatus()
  })

  void applyEnabled()
}

export async function stopRemote(): Promise<void> {
  await bridge?.stop()
}
