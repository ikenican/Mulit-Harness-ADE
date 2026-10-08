import { useEffect, useState } from 'react'
import type { AgentId, UsageBucket, UsageRange } from '../../../preload/index'
import { useWorkbench } from '@/store'
import { useTranslation } from '@/i18n'
import AgentMark from '@/components/AgentMark'
import UsageRangeSwitch, { formatTokens } from '@/components/UsageRangeSwitch'

type Usage = Record<AgentId, Record<UsageRange, UsageBucket>>
const AGENTS: AgentId[] = ['claude', 'codex', 'antigravity']
const AGENT_NAMES: Record<AgentId, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' }

/** Vibe 模式終端上方狀態列：各 Agent 在選定區間的 token 用量（取代 Dashboard 用量卡） */
export default function VibeUsageBar(): JSX.Element {
  const { usageRange, agentBusy, settingsTick, liveAgentSessionIds } = useWorkbench()
  const { t } = useTranslation()
  const [usage, setUsage] = useState<Usage | null>(null)
  const [cliEnabled, setCliEnabled] = useState<Record<string, boolean | undefined>>({})

  // 顯示哪些 Agent 跟 Settings 的 CLI 啟用開關連動（與 Dashboard 相同規則：未明確關閉即顯示）
  useEffect(() => {
    window.api.settings
      .get()
      .then((s) => setCliEnabled(s?.cliEnabled || {}))
      .catch(() => {})
  }, [settingsTick])

  useEffect(() => {
    let alive = true
    const load = (): void => {
      window.api.dashboard
        .usage()
        .then((u) => alive && setUsage(u))
        .catch(() => {})
    }
    load()
    // 檔案沒變就吃快取，15 秒一次很便宜；設定變更或開了新 Agent 會話時立刻重抓
    const id = setInterval(load, 15000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [settingsTick, liveAgentSessionIds.length])

  const shown = usage ? AGENTS.filter((a) => cliEnabled[a] !== false && usage[a]) : []

  return (
    <div className="vibe-usage-bar">
      {!usage && <span className="vibe-usage-dim">{t('common.loading')}</span>}
      {shown.map((a) => {
        const u = usage![a][usageRange]
        const total = u.input + u.cacheRead + u.output
        return (
          <span
            key={a}
            className="vibe-usage-item"
            title={`${t('usage.inTip')}: ${u.input.toLocaleString()}\n${t('usage.cacheTip')}: ${u.cacheRead.toLocaleString()}\n${t('usage.outTip')}: ${u.output.toLocaleString()}${a === 'antigravity' ? `\n(${t('usage.estimated')})` : ''}`}
          >
            <AgentMark agent={a} size={13} />
            <span className="vibe-usage-name">{AGENT_NAMES[a]}</span>
            <strong>
              {a === 'antigravity' ? '≈' : ''}
              {formatTokens(total)}
            </strong>
          </span>
        )
      })}
      <span className="vibe-usage-spacer" />
      {agentBusy && <span className="vibe-usage-busy" title={t('vibe.agentWorking')} />}
      <UsageRangeSwitch compact />
    </div>
  )
}
