import { useCallback, useEffect, useState } from 'react'
import { DiffEditor } from '@monaco-editor/react'
import { useWorkbench } from '@/store'
import AgentMark from '@/components/AgentMark'
import './customized.css'
import type {
  AgentId,
  AgentStatus,
  ConnectionInfo,
  ExtItem,
  ExtKind,
  FileChange,
  SupportState
} from '../../../../preload/index'

const KIND_LABEL: Record<ExtKind, string> = { skill: 'Skills', mcp: 'MCP', plugin: 'Plugins' }
const AGENT_SHORT: Record<AgentId, string> = {
  claude: 'Claude',
  antigravity: 'Antigravity',
  codex: 'Codex'
}
const STATE_LABEL: Record<SupportState, string> = {
  installed: 'Installed',
  missing: 'Not installed',
  unsupported: 'N/A',
  pending: 'Pending',
  error: 'Error'
}

function StateChip({ agent, state, detail }: { agent: AgentId; state: SupportState; detail?: string }) {
  const shortName = agent === 'claude' ? 'Claude' : agent === 'antigravity' ? 'AGY' : 'Codex'
  return (
    <span
      className={`cz-chip cz-${state}`}
      title={detail || `${AGENT_SHORT[agent]}: ${STATE_LABEL[state]}`}
    >
      <AgentMark agent={agent} size={11} />
      <i className="cz-dot" />
      <span className="cz-chip-name">{shortName}</span>
    </span>
  )
}

export default function CustomizedPanel(): JSX.Element {
  const { theme } = useWorkbench()
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [items, setItems] = useState<ExtItem[]>([])
  const [conns, setConns] = useState<ConnectionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [lastScanned, setLastScanned] = useState<string | null>(null)
  const [installingCodex, setInstallingCodex] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 同步預覽
  const [changes, setChanges] = useState<FileChange[] | null>(null)
  const [activeChange, setActiveChange] = useState(0)
  const [applying, setApplying] = useState(false)

  // 新增連線
  const [connName, setConnName] = useState('')
  const [connValue, setConnValue] = useState('')

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [a, i, c] = await Promise.all([
        window.api.ext.agents(),
        window.api.ext.inventory(),
        window.api.conn.list()
      ])
      setAgents(a)
      setItems(i)
      setConns(c)
      setLastScanned(new Date().toLocaleTimeString())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleToggleItem = async (it: ExtItem): Promise<void> => {
    const nextState = it.enabled === false ? true : false
    try {
      await window.api.ext.toggleItem(it.kind, it.id, nextState)
      setItems((prev) =>
        prev.map((x) =>
          x.kind === it.kind && x.id === it.id ? { ...x, enabled: nextState } : x
        )
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const doPlan = async (): Promise<void> => {
    try {
      setError(null)
      const plan = await window.api.ext.planSync()
      setChanges(plan)
      setActiveChange(0)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const doApply = async (): Promise<void> => {
    setApplying(true)
    try {
      const { written } = await window.api.ext.applySync()
      setChanges(null)
      await refresh()
      window.api.notify.show('Sync complete', `Wrote ${written.length} config file(s)`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setApplying(false)
    }
  }

  const saveConn = async (): Promise<void> => {
    if (!connName.trim() || !connValue) return
    try {
      setError(null)
      await window.api.conn.set(connName.trim(), connValue)
      setConnName('')
      setConnValue('')
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const byKind = (k: ExtKind): ExtItem[] => items.filter((i) => i.kind === k)

  return (
    <div className="cz-root">
      <div className="cz-toolbar">
        <button className="btn" onClick={refresh} disabled={loading}>
          <span className={`cz-rescan-icon ${loading ? 'cz-spinning' : ''}`}>↻</span>
          {loading ? ' Scanning...' : ' Rescan'}
        </button>
        <button className="btn btn-primary" onClick={doPlan}>
          Sync to agents…
        </button>
        {loading ? (
          <span className="cz-scan-status scanning">Scanning agent configs & environments...</span>
        ) : lastScanned ? (
          <span className="cz-scan-status done">Last rescanned at {lastScanned}</span>
        ) : null}
        <span className="cz-spacer" />
        <span className="cz-hint">Changes are shown for review before anything is written</span>
      </div>

      {error && <div className="cz-error">{error}</div>}

      {/* 三家 agent 狀態卡 */}
      <div className="cz-agents">
        {agents.map((a) => (
          <div key={a.agent} className={`cz-agent-card ${a.pending ? 'pending' : ''}`}>
            <div className="cz-agent-head">
              <strong>{a.label}</strong>
              {a.pending ? (
                <span className="cz-badge pending">Pending</span>
              ) : a.cliFound ? (
                <span className="cz-badge ok">Ready</span>
              ) : (
                <span className="cz-badge warn">CLI not found</span>
              )}
            </div>
            <div className="cz-agent-counts">
              <span>Skills {a.counts.skill}</span>
              <span>MCP {a.counts.mcp}</span>
              <span>Plugins {a.counts.plugin}</span>
            </div>
            <div className="cz-agent-card-scroll">
              {a.configHome && <div className="cz-agent-path" title={a.configHome}>{a.configHome}</div>}
              {a.notes.map((n, i) => (
                <div key={i} className="cz-note">
                  {n}
                </div>
              ))}
              {a.agent === 'codex' && !a.cliFound && (
                <button
                  className="btn cz-install-codex"
                  disabled={installingCodex}
                  onClick={async () => {
                    setInstallingCodex(true)
                    try {
                      const res = await window.api.ext.installCodex()
                      if (res.ok) {
                        window.api.notify.show('Codex Installation', res.message)
                        await refresh()
                      } else {
                        setError(res.message)
                      }
                    } catch (e) {
                      setError(e instanceof Error ? e.message : String(e))
                    } finally {
                      setInstallingCodex(false)
                    }
                  }}
                >
                  {installingCodex ? 'Installing Codex CLI…' : '⬇ Download & Install Codex'}
                </button>
              )}
              {a.agent === 'antigravity' &&
                a.notes.some((n) => n.includes('trust list')) && (
                  <button
                    className="btn cz-trust"
                    onClick={async () => {
                      await window.api.ext.trustWorkspace()
                      await refresh()
                    }}
                  >
                    Add this workspace to trust list
                  </button>
                )}
            </div>
          </div>
        ))}
      </div>

      {/* 擴充清單：三家狀態一覽 */}
      {(['skill', 'mcp', 'plugin'] as ExtKind[]).map((kind) => (
        <section key={kind} className="cz-section">
          <h3>
            {KIND_LABEL[kind]} <span className="cz-count">{byKind(kind).length}</span>
          </h3>
          {byKind(kind).length === 0 ? (
            <div className="cz-empty">No {KIND_LABEL[kind]} detected</div>
          ) : (
            <div className="cz-list">
              {byKind(kind).map((it) => (
                <div
                  key={`${it.kind}:${it.id}`}
                  className={`cz-item ${it.enabled === false ? 'is-disabled' : ''}`}
                >
                  <div className="cz-item-main">
                    <div className="cz-item-title">
                      <span className="cz-title-text" title={it.name}>{it.name}</span>
                      {it.version && <span className="cz-ver">v{it.version}</span>}
                      {it.managed && <span className="cz-managed" title="Managed by the workbench manifest">managed</span>}
                    </div>
                    {it.description && <div className="cz-item-desc">{it.description}</div>}
                    {it.needsConnection && it.needsConnection.length > 0 && (
                      <div className="cz-needs">
                        Requires connection:{' '}
                        {it.needsConnection.map((n) => {
                          const set = conns.find((c) => c.name === n)?.isSet
                          return (
                            <span key={n} className={set ? 'cz-conn ok' : 'cz-conn miss'}>
                              {n}
                              {set ? ' ✓' : ' not set'}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="cz-item-agents">
                    {it.agents.map((a) => (
                      <StateChip key={a.agent} agent={a.agent} state={a.state} detail={a.detail} />
                    ))}
                  </div>
                  <div className="cz-item-actions">
                    <button
                      className={`cz-toggle-switch ${it.enabled !== false ? 'on' : 'off'}`}
                      onClick={() => handleToggleItem(it)}
                      title={it.enabled !== false ? 'Enabled (Click to disable)' : 'Disabled (Click to enable)'}
                    >
                      <span className="cz-toggle-thumb" />
                      <span className="cz-toggle-label">{it.enabled !== false ? 'ON' : 'OFF'}</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ))}

      {/* 連線憑證 */}
      <section className="cz-section">
        <h3>
          Connections <span className="cz-count">{conns.length}</span>
        </h3>
        <div className="cz-conn-note">
          Values are encrypted with the OS keychain into <code>.workbench/credentials.enc</code> (gitignored). They are never written into any agent config — they are injected as environment variables when a CLI is launched.
        </div>
        <div className="cz-list">
          {conns.map((c) => (
            <div key={c.name} className="cz-item">
              <div className="cz-item-main">
                <div className="cz-item-title">
                  {c.name}
                  <span className={c.isSet ? 'cz-conn ok' : 'cz-conn miss'}>
                    {c.isSet ? 'Set' : 'Not set'}
                  </span>
                </div>
                {c.usedBy.length > 0 && (
                  <div className="cz-item-desc">Used by: {c.usedBy.join(', ')}</div>
                )}
              </div>
              {c.isSet && (
                <button
                  className="btn"
                  onClick={async () => {
                    await window.api.conn.remove(c.name)
                    await refresh()
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="cz-conn-form">
          <input
            placeholder="Connection name (e.g. notion)"
            value={connName}
            onChange={(e) => setConnName(e.target.value)}
          />
          <input
            type="password"
            placeholder="Token / API Key"
            value={connValue}
            onChange={(e) => setConnValue(e.target.value)}
          />
          <button className="btn btn-primary" onClick={saveConn} disabled={!connName || !connValue}>
            Save
          </button>
        </div>
      </section>

      {/* 同步預覽 */}
      {changes && (
        <div className="cz-modal-bg" onClick={() => setChanges(null)}>
          <div className="cz-modal" onClick={(e) => e.stopPropagation()}>
            <div className="cz-modal-head">
              <strong>Sync preview</strong>
              <span className="cz-hint">
                {changes.length === 0 ? 'Nothing to change' : `${changes.length} file(s) will be written`}
              </span>
              <span className="cz-spacer" />
              <button className="btn" onClick={() => setChanges(null)}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={doApply}
                disabled={changes.length === 0 || applying}
              >
                {applying ? 'Writing…' : 'Apply changes'}
              </button>
            </div>
            {changes.length > 0 && (
              <>
                <div className="cz-modal-files">
                  {changes.map((c, i) => (
                    <button
                      key={c.path}
                      className={`cz-file ${i === activeChange ? 'on' : ''}`}
                      onClick={() => setActiveChange(i)}
                      title={c.path}
                    >
                      <span className={`cz-chip cz-installed cz-mini`}>{AGENT_SHORT[c.agent]}</span>
                      {c.path.split(/[\\/]/).slice(-2).join('/')}
                    </button>
                  ))}
                </div>
                {changes[activeChange]?.note && (
                  <div className="cz-modal-note">{changes[activeChange].note}</div>
                )}
                <div className="cz-modal-diff">
                  <DiffEditor
                    original={changes[activeChange]?.before ?? ''}
                    modified={changes[activeChange]?.after ?? ''}
                    theme={theme === 'dark' ? 'vs-dark' : 'light'}
                    options={{ renderSideBySide: true, readOnly: true, minimap: { enabled: false } }}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
