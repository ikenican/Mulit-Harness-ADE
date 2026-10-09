import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RemoteFileEntry } from '../../shared/remoteProtocol'

const IGNORED = new Set(['.git', 'node_modules', 'out', '.deps'])
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.pdf': 'application/pdf',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2'
}

/** Both the requested path and symlink target must stay inside this workspace. */
export function workspacePath(root: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length > 4096 || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('invalid path')
  const realRoot = fs.realpathSync(root)
  const candidate = path.resolve(realRoot, relative)
  const check = (target: string): void => {
    const rel = path.relative(realRoot, target)
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('path outside workspace')
  }
  check(candidate)
  const real = fs.realpathSync(candidate)
  check(real)
  return real
}

export function listWorkspaceFiles(root: string, relative: string): RemoteFileEntry[] {
  const dir = workspacePath(root, relative)
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !IGNORED.has(e.name) && !e.isSymbolicLink())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 2000)
    .map(e => ({ name: e.name, path: path.relative(fs.realpathSync(root), path.join(dir, e.name)).replace(/\\/g, '/'), isDir: e.isDirectory() }))
}

export function readWorkspaceText(root: string, relative: string): string {
  const file = workspacePath(root, relative)
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('text preview limit is 1 MB')
  const data = fs.readFileSync(file)
  if (data.includes(0)) throw new Error('binary file cannot be previewed as text')
  return data.toString('utf8')
}

/** Scoped, expiring preview URLs; HTML gets an opaque sandbox origin even when opened directly. */
export class RemoteFiles {
  private grants = new Map<string, { root: string; deviceId: string; expiresAt: number }>()
  private authorized: (deviceId: string, root: string) => boolean

  constructor(authorized: (deviceId: string, root: string) => boolean) { this.authorized = authorized }

  clear(): void { this.grants.clear() }

  issueUrl(host: string, root: string, relative: string, deviceId: string): string {
    const file = workspacePath(root, relative)
    if (!fs.statSync(file).isFile()) throw new Error('not a file')
    for (const [key, grant] of this.grants) if (grant.expiresAt < Date.now()) this.grants.delete(key)
    // ponytail: cap preview grants at 100; reopen a file if an old preview expires or is evicted.
    if (this.grants.size >= 100) this.grants.delete(this.grants.keys().next().value!)
    const key = crypto.randomBytes(24).toString('hex')
    this.grants.set(key, { root, deviceId, expiresAt: Date.now() + 30 * 60_000 })
    const rel = path.relative(fs.realpathSync(root), file).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/')
    // ponytail: relative HTML assets work as files; root-relative URLs need the dev-server Preview.
    return `https://${host}/_files/${key}/${rel}`
  }

  serve(req: IncomingMessage, res: ServerResponse): void {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      const parts = new URL(req.url || '/', 'https://localhost').pathname.split('/')
      const grant = this.grants.get(parts[2])
      if (!grant || grant.expiresAt < Date.now() || !this.authorized(grant.deviceId, grant.root)) { res.writeHead(403); res.end(); return }
      const file = workspacePath(grant.root, parts.slice(3).map(decodeURIComponent).join('/'))
      const stat = fs.statSync(file)
      if (!stat.isFile()) throw new Error('not a file')
      const headers: Record<string, string | number> = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
        'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes',
        'Content-Security-Policy': (['.html', '.htm', '.svg'].includes(path.extname(file).toLowerCase()) ? 'sandbox allow-scripts; ' : '') +
          "default-src 'none'; script-src https: 'unsafe-inline'; style-src https: 'unsafe-inline'; img-src https: data:; font-src https: data:; connect-src 'none'; form-action 'none'; base-uri 'none'"
      }
      let start = 0, end = stat.size - 1, status = 200
      if (req.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range)
        if (!range || (!range[1] && !range[2])) throw new Error('invalid range')
        start = range[1] ? Number(range[1]) : Math.max(0, stat.size - Number(range[2]))
        end = range[1] && range[2] ? Math.min(end, Number(range[2])) : end
        if (start > end || start >= stat.size) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); res.end(); return }
        headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
        status = 206
      }
      headers['Content-Length'] = Math.max(0, end - start + 1)
      res.writeHead(status, headers)
      if (req.method === 'HEAD' || !stat.size) { res.end(); return }
      const stream = fs.createReadStream(file, { start, end })
      stream.on('error', () => res.destroy())
      res.on('close', () => stream.destroy())
      stream.pipe(res)
    } catch {
      if (!res.headersSent) res.writeHead(404)
      res.end()
    }
  }
}
