import { app, safeStorage } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import { join } from 'path'
import type { PushSubscriptionJSON } from './webpush'

// 遠端控制的本機狀態，全部放在 userData/remote/（不進任何專案、不進版控）：
//   config.json   開關與 port
//   devices.json  已配對裝置（只存 token 的 SHA-256，不存明文）
//   secrets.json  CA / server 私鑰與 VAPID 私鑰，以 OS 金鑰（safeStorage）加密
//   audit.log     配對、連線、開關終端等事件（不記錄輸入內容，避免把密碼寫進 log）

export interface RemoteConfig {
  enabled: boolean
  port: number
}

export interface DeviceRecord {
  id: string
  name: string
  tokenHash: string
  createdAt: number
  lastSeenAt: number
  push?: PushSubscriptionJSON
}

interface SealedValue {
  enc: 'safe' | 'plain'
  data: string
}

interface SecretsFile {
  caCert?: string
  caKey?: SealedValue
  serverCert?: string
  serverKey?: SealedValue
  vapidPublic?: string
  vapidPrivate?: SealedValue
}

export const DEFAULT_PORT = 47600

function dir(): string {
  return join(app.getPath('userData'), 'remote')
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(join(dir(), name), 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(name: string, value: unknown): void {
  fs.mkdirSync(dir(), { recursive: true })
  const p = join(dir(), name)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, p)
}

function seal(plain: string): SealedValue {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: 'safe', data: safeStorage.encryptString(plain).toString('base64') }
  }
  // Linux 沒有 keyring 時退回明文（檔案權限 0600），與 Electron 自身行為一致
  return { enc: 'plain', data: plain }
}

function unseal(v?: SealedValue): string | null {
  if (!v) return null
  try {
    return v.enc === 'safe' ? safeStorage.decryptString(Buffer.from(v.data, 'base64')) : v.data
  } catch {
    return null
  }
}

export function loadConfig(): RemoteConfig {
  const c = readJson<Partial<RemoteConfig>>('config.json', {})
  const port = Number(c.port)
  return {
    enabled: !!c.enabled,
    // bridge 會用到 port、port+1（CA 安裝頁）、port+2（手機預覽代理），所以上限留 3 個
    port: Number.isInteger(port) && port > 1024 && port < 65533 ? port : DEFAULT_PORT
  }
}

export function saveConfig(patch: Partial<RemoteConfig>): RemoteConfig {
  const next = { ...loadConfig(), ...patch }
  writeJson('config.json', next)
  return next
}

// —— 裝置 ——

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function loadDevices(): DeviceRecord[] {
  const list = readJson<DeviceRecord[]>('devices.json', [])
  return Array.isArray(list) ? list : []
}

export function saveDevices(list: DeviceRecord[]): void {
  writeJson('devices.json', list)
}

export function findDeviceByToken(token: string): DeviceRecord | null {
  if (!token || token.length > 200) return null
  const h = Buffer.from(hashToken(token), 'hex')
  for (const d of loadDevices()) {
    const dh = Buffer.from(d.tokenHash, 'hex')
    if (dh.length === h.length && crypto.timingSafeEqual(dh, h)) return d
  }
  return null
}

export function addDevice(name: string): { device: DeviceRecord; token: string } {
  const token = crypto.randomBytes(32).toString('base64url')
  const device: DeviceRecord = {
    id: crypto.randomUUID(),
    name: name.slice(0, 60) || 'iPhone',
    tokenHash: hashToken(token),
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  }
  saveDevices([...loadDevices(), device])
  return { device, token }
}

export function updateDevice(id: string, patch: Partial<DeviceRecord>): void {
  saveDevices(loadDevices().map((d) => (d.id === id ? { ...d, ...patch } : d)))
}

export function removeDevice(id: string): void {
  saveDevices(loadDevices().filter((d) => d.id !== id))
}

// —— 金鑰 ——

export interface StoredCerts {
  caCert: string
  caKey: string
  serverCert?: string
  serverKey?: string
}

export function loadCerts(): StoredCerts | null {
  const s = readJson<SecretsFile>('secrets.json', {})
  const caKey = unseal(s.caKey)
  if (!s.caCert || !caKey) return null
  const serverKey = unseal(s.serverKey) || undefined
  return { caCert: s.caCert, caKey, serverCert: serverKey ? s.serverCert : undefined, serverKey }
}

export function saveCerts(c: StoredCerts): void {
  const s = readJson<SecretsFile>('secrets.json', {})
  writeJson('secrets.json', {
    ...s,
    caCert: c.caCert,
    caKey: seal(c.caKey),
    serverCert: c.serverCert,
    serverKey: c.serverKey ? seal(c.serverKey) : undefined
  })
}

export function loadVapid(): { publicKey: string; privateKeyPem: string } | null {
  const s = readJson<SecretsFile>('secrets.json', {})
  const priv = unseal(s.vapidPrivate)
  return s.vapidPublic && priv ? { publicKey: s.vapidPublic, privateKeyPem: priv } : null
}

export function saveVapid(v: { publicKey: string; privateKeyPem: string }): void {
  const s = readJson<SecretsFile>('secrets.json', {})
  writeJson('secrets.json', { ...s, vapidPublic: v.publicKey, vapidPrivate: seal(v.privateKeyPem) })
}

/** 重設信任：刪掉 CA 與所有已配對裝置（手機上的舊憑證要使用者自行移除） */
export function resetAll(): void {
  for (const f of ['secrets.json', 'devices.json']) {
    try {
      fs.rmSync(join(dir(), f), { force: true })
    } catch {
      // ignore
    }
  }
}

export function audit(event: string, detail: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(dir(), { recursive: true })
    const p = join(dir(), 'audit.log')
    // 超過 1MB 就輪替一次，避免無限長大
    try {
      if (fs.statSync(p).size > 1024 * 1024) fs.renameSync(p, `${p}.1`)
    } catch {
      // 還沒有檔案
    }
    fs.appendFileSync(p, JSON.stringify({ t: new Date().toISOString(), event, ...detail }) + '\n', { mode: 0o600 })
  } catch {
    // audit 失敗不影響功能
  }
}
