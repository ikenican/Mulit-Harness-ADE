import { ipcMain, safeStorage } from 'electron'
import * as fs from 'fs'
import { join, dirname } from 'path'
import { workspace } from '../index'
import { readManifest, connRefsOf, splitEnv } from '../ext/manifest'
import type { ConnectionInfo } from '../../preload/index'

// 連線憑證：以 OS 金鑰（Electron safeStorage）加密後存本機檔，該檔已 gitignore。
// 值只在 main process 解密，且只在 spawn CLI 時注入 env —— 不寫進任何 agent 設定檔、
// 不回傳 renderer、不進 repo（ShareProjectMem 的 pre-commit secret scan 因此不會被觸發）。

const STORE_REL = '.workbench/credentials.enc'

function storePath(): string {
  return join(workspace.root, STORE_REL)
}

type Store = Record<string, string> // name -> base64(encrypted)

function load(): Store {
  try {
    return JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Store
  } catch {
    return {}
  }
}

function save(s: Store): void {
  const p = storePath()
  fs.mkdirSync(dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8')
}

/** 解出單一憑證明文；僅限 main process 內部使用（spawn 注入）。 */
function reveal(name: string): string | null {
  const s = load()
  const b64 = s[name]
  if (!b64) return null
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

/**
 * 給 pty spawn 用：把 manifest 中所有 ${conn:x} 佔位解成真實 env。
 * 回傳 { ENV_KEY: 明文 }，由呼叫端併進子行程 env。
 */
export function resolveConnectionEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  const m = readManifest(workspace.root)
  for (const mcp of m.mcp) {
    const { secret } = splitEnv(mcp.env)
    for (const [envKey, connName] of Object.entries(secret)) {
      const v = reveal(connName)
      if (v) out[envKey] = v
    }
  }
  return out
}

export function registerConnHandlers(): void {
  ipcMain.handle('conn:list', async (): Promise<ConnectionInfo[]> => {
    const store = load()
    const m = readManifest(workspace.root)

    // manifest 要求的憑證 + 已存在但 manifest 沒再用到的（孤兒）
    const usage = new Map<string, string[]>()
    for (const mcp of m.mcp) {
      for (const name of connRefsOf(mcp.env)) {
        usage.set(name, [...(usage.get(name) || []), `mcp:${mcp.id}`])
      }
    }
    for (const name of Object.keys(store)) {
      if (!usage.has(name)) usage.set(name, [])
    }

    return [...usage.entries()]
      .map(([name, usedBy]) => ({ name, isSet: !!store[name], usedBy }))
      .sort((a, b) => a.name.localeCompare(b.name))
  })

  ipcMain.handle('conn:set', async (_e, name: string, value: string): Promise<void> => {
    if (!name?.trim()) throw new Error('Connection name cannot be empty')
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS-backed encryption is unavailable on this system; refusing to store the credential in plain text')
    }
    const s = load()
    s[name.trim()] = safeStorage.encryptString(value).toString('base64')
    save(s)
  })

  ipcMain.handle('conn:remove', async (_e, name: string): Promise<void> => {
    const s = load()
    delete s[name]
    save(s)
  })
}
