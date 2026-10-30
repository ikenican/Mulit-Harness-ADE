import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import AppleAlertDialog from './AppleAlertDialog'
import { IconPuzzle } from './Icons'
import type { MemoryPluginAgent, MemoryPluginAgentState, MemoryPluginApplyResult, MemoryPluginState } from '../../../preload/index'

// Workbench 自帶的 shared-project-memory plugin。設定頁開啟時（auto）檢查已啟用的 Claude Code／Codex：
// 沒裝、自帶版較舊、或裝的是 GitHub 等其他來源時，徵求同意後裝上自帶版並移除舊的。
// 拒絕後說明記憶交接會少什麼；同一個自帶版本不再自動詢問，記憶同步頁仍可隨時安裝。

/** 需要處理的 agent：設定裡啟用、找得到 CLI、還不是自帶的最新版 */
const pendingAgents = (s: MemoryPluginState | null): MemoryPluginAgentState[] => s?.agents.filter((a) => a.enabled && a.cli && a.action !== 'ok') ?? []
const AGENT_NAME: Record<MemoryPluginAgent, string> = { claude: 'Claude Code', codex: 'Codex', antigravity: 'Antigravity' }

type Phase = 'closed' | 'ask' | 'busy' | 'declined' | 'done'

export default function MemoryPluginPrompt({ auto = false }: { auto?: boolean }): JSX.Element | null {
  const { t } = useTranslation()
  const [st, setSt] = useState<MemoryPluginState | null>(null)
  const [phase, setPhase] = useState<Phase>('closed')
  const [results, setResults] = useState<MemoryPluginApplyResult[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.api.memsync.pluginState().then((r) => {
      if (!alive || !r.ok) return
      setSt(r.data)
      if (auto && pendingAgents(r.data).length && r.data.declined !== r.data.bundledVersion) setPhase('ask')
    })
    return () => {
      alive = false
    }
  }, [auto])

  const pending = pendingAgents(st)
  // 拒絕的警示要照「當時要處理的項目」寫，所以先記住
  const [asked, setAsked] = useState<MemoryPluginAgentState[]>([])
  if (!st) return null
  const version = st.bundledVersion

  const apply = async (): Promise<void> => {
    setPhase('busy')
    setError(null)
    const r = await window.api.memsync.applyPlugin(pending.map((a) => a.agent))
    if (r.ok) {
      setResults(r.data.results)
      setSt(r.data.state)
    } else setError(r.message)
    setPhase('done')
  }
  const decline = async (): Promise<void> => {
    setAsked(pending)
    const r = await window.api.memsync.declinePlugin()
    if (r.ok) setSt(r.data)
    setPhase('declined')
  }
  const row = (a: MemoryPluginAgentState): string => {
    const from = a.installed.map((p) => (p.version ? `${p.key} v${p.version}` : p.key)).join(', ')
    const key = a.action === 'migrate' ? 'memsync.plugin.rowMigrate' : a.action === 'update' ? 'memsync.plugin.rowUpdate' : 'memsync.plugin.rowInstall'
    return t(key, { agent: AGENT_NAME[a.agent], from, version })
  }
  const list = (items: string[]): JSX.Element => (
    <ul style={{ margin: '4px 0 8px', paddingLeft: 18, textAlign: 'left' }}>
      {items.map((s) => (
        <li key={s}>{s}</li>
      ))}
    </ul>
  )
  const close = (): void => setPhase('closed')
  const failed = !!error || results.some((r) => !r.ok)

  const dialog = {
    ask: {
      title: t('memsync.plugin.askTitle'),
      description: t('memsync.plugin.askDesc', { version }),
      detail: (
        <>
          {list(pending.map(row))}
          {list([t('memsync.plugin.noteHook'), t('memsync.plugin.noteRestart'), t('memsync.plugin.noteData')])}
        </>
      ),
      confirmLabel: t('memsync.plugin.install'),
      cancelLabel: t('memsync.plugin.notNow'),
      onConfirm: apply,
      onClose: decline
    },
    busy: {
      title: t('memsync.plugin.busyTitle'),
      description: pending.map((a) => AGENT_NAME[a.agent]).join(', '),
      detail: undefined,
      confirmLabel: t('memsync.plugin.busyTitle'),
      cancelLabel: null,
      onConfirm: () => {},
      onClose: () => {}
    },
    declined: {
      title: t('memsync.plugin.declinedTitle'),
      description: t('memsync.plugin.declinedDesc'),
      detail: (
        <>
          {list([
            t('memsync.plugin.lossLive'),
            t('memsync.plugin.lossHandoff'),
            ...(asked.some((a) => a.action === 'migrate') ? [t('memsync.plugin.lossMigrate')] : [])
          ])}
          <p style={{ margin: 0 }}>{t('memsync.plugin.declinedHint')}</p>
        </>
      ),
      confirmLabel: t('memsync.plugin.installNow'),
      cancelLabel: t('memsync.plugin.ok'),
      onConfirm: apply,
      onClose: close
    },
    done: {
      title: t(failed ? 'memsync.plugin.failTitle' : 'memsync.plugin.doneTitle'),
      description: failed ? undefined : t('memsync.plugin.doneRestart'),
      detail: list([
        ...(error ? [error] : []),
        ...results.map((r) => (r.ok ? t('memsync.plugin.doneOk', { agent: AGENT_NAME[r.agent] }) : t('memsync.plugin.doneFail', { agent: AGENT_NAME[r.agent], error: r.error || '' })))
      ]),
      confirmLabel: t('memsync.plugin.ok'),
      cancelLabel: null,
      onConfirm: close,
      onClose: close
    }
  }
  const d = phase === 'closed' ? null : dialog[phase]

  return (
    <>
      {!auto && pending.length > 0 && (
        <div className="remote-note warn" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 260px' }}>⚠️ {t('memsync.plugin.banner', { agents: pending.map(row).join('; ') })}</span>
          <button type="button" className="macos-btn-secondary" onClick={() => setPhase('ask')}>
            {t('memsync.plugin.setUp')}
          </button>
        </div>
      )}
      <AppleAlertDialog isOpen={!!d} isDestructive={false} icon={<IconPuzzle size={22} />} {...(d ?? dialog.ask)} />
    </>
  )
}
