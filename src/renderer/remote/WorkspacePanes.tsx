import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { ServerMessage } from '../../shared/remoteProtocol'
import type { RemoteConnection } from './conn'
import { AgentMark } from './icons'
import { t } from './i18n'

type StatusMessage = Extract<ServerMessage, { t: 'status' }>
type FilesMessage = Extract<ServerMessage, { t: 'files' }>
type FileMessage = Extract<ServerMessage, { t: 'file' }>
const parentPath = (path: string): string => path.split('/').slice(0, -1).join('/')

function elapsed(from: string, to?: string): string {
  const s = Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 1000)
  if (!(s >= 0)) return ''
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`
}

export function StatusPane({ conn, windowId, onFile, onPreview }: {
  conn: RemoteConnection; windowId: number; onFile: (path: string) => void; onPreview?: () => void
}): JSX.Element {
  const [data, setData] = useState<StatusMessage | null>(null)
  useEffect(() => {
    const off = conn.onMessage(m => { if (m.t === 'status' && m.windowId === windowId) setData(m) })
    const load = (): void => { if (document.visibilityState === 'visible') conn.send({ t: 'status', windowId }) }
    const offState = conn.onState(s => { if (s === 'open') load() })
    load()
    const timer = window.setInterval(load, 4000)
    return () => { off(); offState(); window.clearInterval(timer) }
  }, [conn, windowId])
  if (data?.error) return <p className="form-error" role="alert">{data.error}</p>
  if (!data?.status) return <p className="empty">{t('loading')}</p>
  const { status, bgTasks } = data
  const relative = (p: string): string => {
    const root = status.workspace.replace(/\\/g, '/').replace(/\/$/, ''), normalized = p.replace(/\\/g, '/')
    return normalized.toLowerCase().startsWith(root.toLowerCase() + '/') ? normalized.slice(root.length + 1) : normalized
  }
  return (
    <section className="bubble remote-status">
      <div className={`pill ${status.agentBusy ? 'run' : 'idle'}`} role="status">
        <span className="dot" />
        {status.agentBusy ? t('agentWorking') : status.agentCount ? t('agentIdle', { n: status.agentCount }) : t('noAgent')}
      </div>
      {status.devUrl && <div className="remote-dev-server"><h2>{t('devServer')}</h2>
        {onPreview ? <button className="text-btn" onClick={onPreview}>{status.devUrl}</button> : <span className="git-path">{status.devUrl}</span>}
      </div>}
      <div className="section-head"><h2>{t('bgTasks', { n: bgTasks.filter(b => b.status === 'running').length })}</h2></div>
      {bgTasks.slice(0, 8).map(b => <div className="remote-task" key={b.id} title={b.summary || b.desc}>
        <AgentMark launcherKey={b.agent} />
        <span className="card-main"><span className="card-title">{b.desc}</span><span className="card-sub">{b.status}</span></span>
        <span className="t-foot">{elapsed(b.startedAt, b.endedAt)}</span>
      </div>)}
      <div className="section-head"><h2>{t('changedFiles', { n: status.changedFiles.length })}</h2></div>
      {status.changedFiles.map(p => <button className="remote-file-row press" key={p} onClick={() => onFile(relative(p))}>{relative(p)}</button>)}
    </section>
  )
}

export function FilePane({ conn, windowId, initialPath = '' }: {
  conn: RemoteConnection; windowId: number; initialPath?: string
}): JSX.Element {
  const [dir, setDir] = useState(parentPath(initialPath))
  const [selected, setSelected] = useState(initialPath)
  const [listing, setListing] = useState<FilesMessage | null>(null)
  const [file, setFile] = useState<FileMessage | null>(null)
  useEffect(() => {
    setListing(null)
    setFile(null)
    const off = conn.onMessage(m => {
      if (m.t === 'files' && m.windowId === windowId && m.path === dir) setListing(m)
      if (m.t === 'file' && m.windowId === windowId && m.path === selected) setFile(m)
    })
    const load = (): void => conn.send(selected ? { t: 'file', windowId, path: selected } : { t: 'files', windowId, path: dir })
    const offState = conn.onState(s => { if (s === 'open') load() })
    load()
    return () => { off(); offState() }
  }, [conn, windowId, dir, selected])
  const back = (): void => { if (selected) { setDir(parentPath(selected)); setSelected('') } else setDir(parentPath(dir)) }
  const current = selected || dir
  return (
    <div className="remote-files">
      <div className="remote-file-head">
        {current && <button className="text-btn" onClick={back}>← {t('back')}</button>}
        <span className="git-path">{current || '/'}</span>
        {file?.url && <a className="text-btn" href={file.url} target="_blank" rel="noreferrer">{t('openPreview')}</a>}
      </div>
      {selected ? !file ? <p className="empty">{t('loading')}</p> : file.error ? <p className="form-error" role="alert">{file.error}</p> :
        file.kind === 'markdown' ? <article className="bubble markdown">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
            img: ({ src, ...props }) => {
              let resolved = src
              try { if (src && file.url) resolved = new URL(src, file.url).href } catch { /* Keep malformed image URLs from breaking the document. */ }
              return <img {...props} src={resolved} />
            },
            a: ({ href, children }) => <a href={href} onClick={e => {
              if (href && !/^(?:[a-z]+:|\/\/|#)/i.test(href)) { e.preventDefault(); setSelected([parentPath(selected), href.split('#')[0]].filter(Boolean).join('/')) }
            }} target="_blank" rel="noreferrer">{children}</a>
          }}>{file.text || ''}</ReactMarkdown>
        </article> : file.kind === 'html' || file.kind === 'pdf' ?
          <iframe className="remote-file-frame" src={file.url || undefined} title={selected} sandbox={file.kind === 'html' ? 'allow-scripts' : undefined} /> :
          <pre className="bubble remote-file-text">{file.text}</pre>
        : !listing ? <p className="empty">{t('loading')}</p> : listing.error ? <p className="form-error" role="alert">{listing.error}</p> :
          <div className="bubble remote-file-list">
            {!listing.entries.length && <p className="empty">{t('noFiles')}</p>}
            {listing.entries.map(entry => <button className="remote-file-row press" key={entry.path} onClick={() => {
              if (entry.isDir) setDir(entry.path)
              else setSelected(entry.path)
            }}><span aria-hidden="true">{entry.isDir ? '📁' : '▤'}</span> {entry.name}</button>)}
          </div>}
    </div>
  )
}
