import * as fs from 'fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { randomUUID } from 'crypto'
import { CUSTOM_RESOURCE_KINDS, type CustomAgentConfig, type CustomResourceKind } from '../../shared/customAgent'

const MAX_BYTES = 1024 * 1024

function resource(config: CustomAgentConfig, kind: CustomResourceKind): { root: string; directory: boolean } {
  if (!config.enabled) throw new Error('Custom Agent is disabled')
  if (!CUSTOM_RESOURCE_KINDS.includes(kind)) throw new Error('Unknown extension kind')
  const root = config.resources[kind]
  if (!root || !isAbsolute(root)) throw new Error('Set an absolute extension path in Settings → Agents first')
  return { root: resolve(root), directory: kind === 'skill' || kind === 'plugin' }
}

function noSymlinks(target: string, root: string): void {
  let current = target
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolic links are not editable here')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (current === root) break
    current = dirname(current)
  }
}

function targetPath(config: CustomAgentConfig, kind: CustomResourceKind, file: string): string {
  const { root, directory } = resource(config, kind)
  if (typeof file !== 'string' || !file || isAbsolute(file) || file.split(/[\\/]/).some((s) =>
    !s || s === '.' || s === '..' || /[<>:"|?*\x00-\x1f]/.test(s) || /[. ]$/.test(s) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s)
  )) throw new Error('Use a relative file name without special characters or parent traversal')
  if (file.toLowerCase().endsWith('.workbench-backup')) throw new Error('Backup files are read-only')
  const target = directory ? resolve(root, file) : root
  if (!directory && file !== basename(root)) throw new Error('Only the configured file can be edited')
  const rel = relative(directory ? root : dirname(root), target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('File is outside the configured extension path')
  noSymlinks(target, directory ? root : dirname(root))
  return target
}

export function listCustomFiles(config: CustomAgentConfig, kind: CustomResourceKind): string[] {
  const { root, directory } = resource(config, kind)
  noSymlinks(root, root)
  if (!directory) return [basename(root)]
  if (!fs.existsSync(root)) return []
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink() || e.name === 'node_modules' || e.name === '.git' || e.name.toLowerCase().endsWith('.workbench-backup')) continue
      if (e.isDirectory()) {
        if (depth < 6) walk(join(dir, e.name), depth + 1)
      } else if (e.isFile()) {
        files.push(relative(root, join(dir, e.name)).replace(/\\/g, '/'))
        if (files.length > 500) throw new Error('More than 500 extension files; choose a smaller directory')
      }
    }
  }
  // shortcut: list six directory levels, choose a narrower root for deeply nested plugin caches.
  walk(root, 0)
  return files.sort()
}

export function readCustomFile(config: CustomAgentConfig, kind: CustomResourceKind, file: string): string | null {
  const target = targetPath(config, kind, file)
  try {
    if (fs.statSync(target).size > MAX_BYTES) throw new Error('Only text files up to 1 MB can be edited')
    const raw = fs.readFileSync(target)
    const text = raw.toString('utf8')
    if (text.includes('\0') || !Buffer.from(text).equals(raw)) throw new Error('Only UTF-8 text files can be edited')
    return text
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export function writeCustomFile(config: CustomAgentConfig, kind: CustomResourceKind, file: string, content: string, before: string | null): void {
  const target = targetPath(config, kind, file)
  if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES || content.includes('\0')) throw new Error('Only text files up to 1 MB can be saved')
  if (target.toLowerCase().endsWith('.json')) JSON.parse(content)
  if (readCustomFile(config, kind, file) !== before) throw new Error('File changed on disk. Reload before saving')
  fs.mkdirSync(dirname(target), { recursive: true })
  const temp = join(dirname(target), `.workbench-${randomUUID()}.tmp`)
  try {
    fs.writeFileSync(temp, content, { flag: 'wx', mode: before === null ? 0o600 : fs.statSync(target).mode })
    if (before !== null) {
      noSymlinks(`${target}.workbench-backup`, dirname(target))
      if (fs.existsSync(`${target}.workbench-backup`) && fs.statSync(`${target}.workbench-backup`).nlink > 1) {
        throw new Error('Backup destination cannot be a hard link')
      }
      fs.copyFileSync(target, `${target}.workbench-backup`)
      fs.renameSync(temp, target)
    } else {
      // Linking fails if another process created the destination while this form was open.
      fs.linkSync(temp, target)
    }
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp)
  }
}
