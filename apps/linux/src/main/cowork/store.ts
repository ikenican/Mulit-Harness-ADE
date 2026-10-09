// manifest 的原子寫入：同目錄暫存檔 → fsync → 保留上一份 → rename 取代。
// 原子替換只防半截檔，不保證斷電時一定留住最後一次更新（cowork.md §7）。
import * as fs from 'node:fs'
import * as path from 'node:path'

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Windows 上檔案被防毒或同步程式短暫佔用時，rename／copy 會 EPERM／EBUSY：有界重試 */
function withRetry<T>(fn: () => T): T {
  let last: unknown
  for (let i = 0; i < 6; i++) {
    try {
      return fn()
    } catch (e) {
      last = e
      if (!RETRY_CODES.has((e as NodeJS.ErrnoException).code || '')) throw e
      sleepSync(25 * (i + 1))
    }
  }
  throw last
}

/** 寫入 file，並把原本那份留在 <file 去掉 .json>.prev.json */
export function writeJsonAtomic(file: string, data: unknown): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, 'w')
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2))
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  try {
    if (fs.existsSync(file)) withRetry(() => fs.copyFileSync(file, prevPath(file)))
    withRetry(() => fs.renameSync(tmp, file))
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 留著也不影響讀取 */
    }
    throw e
  }
}

export function prevPath(file: string): string {
  return file.replace(/\.json$/, '') + '.prev.json'
}

/**
 * 讀主檔；主檔壞了或驗證失敗就退回上一份。兩份都不行回 null。
 * validate 回傳 false 代表內容形狀不對（例如未知的 schemaVersion）。
 */
export function readJsonWithFallback<T>(
  file: string,
  validate: (v: unknown) => v is T
): { value: T; fromBackup: boolean } | null {
  for (const [p, fromBackup] of [[file, false], [prevPath(file), true]] as const) {
    try {
      const v = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (validate(v)) return { value: v, fromBackup }
    } catch {
      /* 試下一份 */
    }
  }
  return null
}
