import { useEffect, useState, useCallback, useMemo } from 'react'
import type {
  DashboardData,
  AgentId,
  AgentSessionInfo,
  AgentUsageSummary
} from '../../../../preload/index'
import AgentMark from '@/components/AgentMark'
import { IconArchive, IconTrash, IconTerminalBox, IconFolder, IconGripVertical } from '@/components/Icons'
import AppleAlertDialog from '@/components/AppleAlertDialog'
import { openTerminalSession, setDraggedSession, useWorkbench, switchWorkspace, setSidebarTab, openSettings } from '@/store'
import { useTranslation } from '@/i18n'
import './dashboard.css'

interface SessionFolderGroup {
  key: string
  name: string
  path?: string
  isCurrentWorkspace: boolean
  sessions: AgentSessionInfo[]
  totalTokens: number
  activeCount: number
}

const AGENT_CONFIG: Record<
  AgentId,
  { name: string; color: string }
> = {
  claude: {
    name: 'Claude Code',
    color: '#D97706'
  },
  antigravity: {
    name: 'Antigravity',
    color: '#7C3AED'
  },
  codex: {
    name: 'Codex',
    color: '#10A37F'
  }
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return (count / 1_000_000).toFixed(2) + 'M'
  }
  if (count >= 1_000) {
    return (count / 1_000).toFixed(1) + 'k'
  }
  return count.toLocaleString()
}

export default function DashboardPanel(): JSX.Element {
  const [data, setData] = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [viewFilter, setViewFilter] = useState<'all' | 'archived'>('all')
  const [selectedAgent, setSelectedAgent] = useState<AgentId | 'all'>('all')
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null)
  const [lastRefreshed, setLastRefreshed] = useState<string>('')
  const [sessionToDelete, setSessionToDelete] = useState<AgentSessionInfo | null>(null)
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set())
  const [dragOverFolderKey, setDragOverFolderKey] = useState<string | null>(null)

  // 自訂會話排序（各分組 key 對應之 session ID 陣列）與自訂分組覆寫，支援本地持久化
  const [customOrder, setCustomOrder] = useState<Record<string, string[]>>(() => {
    try {
      const saved = localStorage.getItem('agent-workbench:dashboard-order')
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })
  const [folderOverrides, setFolderOverrides] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem('agent-workbench:dashboard-folder-overrides')
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })

  const { workspaceRoot, settingsTick } = useWorkbench()
  const { t } = useTranslation()
  const [cliEnabled, setCliEnabled] = useState<Record<string, boolean | undefined>>({
    claude: true,
    antigravity: true,
    codex: true
  })

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await window.api.dashboard.data()
      setData(res)
      setLastRefreshed(new Date().toLocaleTimeString())
    } catch (e) {
      console.error('Failed to load dashboard data:', e)
    } finally {
      if (!silent) setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    window.api.settings.get().then((s) => {
      if (!active) return
      if (s?.cliEnabled) {
        setCliEnabled(s.cliEnabled)
      }
      loadData(true)
    }).catch((e) => {
      console.error('Failed to load settings in dashboard:', e)
    })
    return () => {
      active = false
    }
  }, [settingsTick, loadData])

  useEffect(() => {
    loadData()
    const interval = setInterval(() => loadData(true), 5000)
    return () => clearInterval(interval)
  }, [loadData])

  const isAgentEnabled = useCallback(
    (agentId: AgentId) => cliEnabled[agentId] !== false,
    [cliEnabled]
  )

  const allAgentIds: AgentId[] = ['claude', 'antigravity', 'codex']
  const enabledAgentIds = allAgentIds.filter(isAgentEnabled)

  useEffect(() => {
    if (selectedAgent !== 'all' && !isAgentEnabled(selectedAgent)) {
      setSelectedAgent('all')
    }
  }, [selectedAgent, isAgentEnabled])

  const toggleExpand = (id: string): void => {
    setExpandedSessionId((prev) => (prev === id ? null : id))
  }

  const handleArchive = async (id: string, currentArchived: boolean, e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    await window.api.dashboard.archiveSession(id, !currentArchived)
    await loadData()
  }

  const handleDeletePrompt = (session: AgentSessionInfo, e: React.MouseEvent): void => {
    e.stopPropagation()
    setSessionToDelete(session)
  }

  const handleConfirmDelete = async (): Promise<void> => {
    if (!sessionToDelete) return
    const id = sessionToDelete.id
    setSessionToDelete(null)
    await window.api.dashboard.deleteSession(id)
    await loadData()
  }

  const agentList: AgentUsageSummary[] = data
    ? Object.values(data.agents).filter((a) => isAgentEnabled(a.agent))
    : []

  const totalTokens: number = agentList.reduce(
    (acc: number, a: AgentUsageSummary) => acc + a.totalTokens,
    0
  )

  const allSessions = (data?.sessions || []).filter((s) => isAgentEnabled(s.agent))
  const activeSessionsCount = allSessions.filter((s) => s.status === 'active').length

  const archivedSessions = allSessions.filter((s) => s.isArchived)
  const unarchivedSessions = allSessions.filter((s) => !s.isArchived)
  const baseSessions = viewFilter === 'archived' ? archivedSessions : unarchivedSessions
  const displayedSessions =
    selectedAgent === 'all'
      ? baseSessions
      : baseSessions.filter((s) => s.agent === selectedAgent)

  // 依執行資料夾歸類 Session（整合自訂拖曳排序與自訂分組覆寫）
  const folderGroups = useMemo<SessionFolderGroup[]>(() => {
    const map = new Map<string, SessionFolderGroup>()
    const normRoot = workspaceRoot ? workspaceRoot.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') : ''
    const currentName = workspaceRoot ? workspaceRoot.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase() || '' : ''

    for (const session of displayedSessions) {
      const rawPath = session.workspacePath?.trim() || ''
      const normPath = rawPath ? rawPath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') : ''
      const wsName = session.workspace?.trim() || (rawPath ? rawPath.split(/[\\/]/).filter(Boolean).pop() || '' : 'Other')

      // 若有手動自訂分組，套用自訂分組 key，否則以原始工作區路徑或名稱為 key
      const overrideKey = folderOverrides[session.id]
      const groupKey = overrideKey || normPath || wsName.toLowerCase()

      let grp = map.get(groupKey)
      if (!grp) {
        const isCurrentWs = Boolean(
          (normRoot && (groupKey === normRoot || normRoot.endsWith(groupKey))) ||
          (currentName && (groupKey === currentName || wsName.toLowerCase() === currentName))
        )
        grp = {
          key: groupKey,
          name: isCurrentWs && workspaceRoot ? workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || wsName : wsName,
          path: rawPath || (isCurrentWs ? workspaceRoot : undefined),
          isCurrentWorkspace: isCurrentWs,
          sessions: [],
          totalTokens: 0,
          activeCount: 0
        }
        map.set(groupKey, grp)
      } else if (!grp.isCurrentWorkspace) {
        const isCurrentWs = Boolean(
          (normRoot && (groupKey === normRoot || normRoot.endsWith(groupKey))) ||
          (currentName && (groupKey === currentName || wsName.toLowerCase() === currentName))
        )
        if (isCurrentWs) grp.isCurrentWorkspace = true
      }

      grp.sessions.push(session)
      grp.totalTokens += session.totalTokens || 0
      if (session.status === 'active') {
        grp.activeCount += 1
      }
    }

    // 依自訂手動排序對各群組內的 sessions 進行排定
    for (const grp of map.values()) {
      const order = customOrder[grp.key]
      if (order && order.length > 0) {
        grp.sessions.sort((a, b) => {
          const idxA = order.indexOf(a.id)
          const idxB = order.indexOf(b.id)
          if (idxA !== -1 && idxB !== -1) return idxA - idxB
          if (idxA !== -1) return -1
          if (idxB !== -1) return 1
          return (new Date(b.lastActiveTime).getTime() || 0) - (new Date(a.lastActiveTime).getTime() || 0)
        })
      }
    }

    const list = Array.from(map.values())
    // 排序：當前工作區置頂，其次為含有活躍 Session 者，最後依各組中最新 session 排序
    list.sort((a, b) => {
      if (a.isCurrentWorkspace && !b.isCurrentWorkspace) return -1
      if (!a.isCurrentWorkspace && b.isCurrentWorkspace) return 1
      if (a.activeCount > 0 && b.activeCount === 0) return -1
      if (a.activeCount === 0 && b.activeCount > 0) return 1
      const aLatest = Math.max(...a.sessions.map((s) => new Date(s.lastActiveTime).getTime() || 0))
      const bLatest = Math.max(...b.sessions.map((s) => new Date(s.lastActiveTime).getTime() || 0))
      return bLatest - aLatest
    })

    return list
  }, [displayedSessions, workspaceRoot, customOrder, folderOverrides])

  // 處理在 Dashboard 視窗內拖曳卡片重新排序與跨群組移動
  const handleReorderSession = useCallback(
    (
      draggedId: string,
      targetId: string | null,
      position: 'before' | 'after' | 'inside',
      targetGroupKey: string
    ) => {
      const draggedSession = displayedSessions.find((s) => s.id === draggedId)
      const rawPath = draggedSession?.workspacePath?.trim() || ''
      const normPath = rawPath ? rawPath.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '') : ''
      const wsName = draggedSession?.workspace?.trim() || (rawPath ? rawPath.split(/[\\/]/).filter(Boolean).pop() || '' : 'Other')
      const naturalKey = normPath || wsName.toLowerCase()

      // 1. 若拖曳跨資料夾，更新分組覆寫（若放回原自然分組則清除覆寫）
      setFolderOverrides((prev) => {
        const next = { ...prev }
        if (targetGroupKey === naturalKey) {
          delete next[draggedId]
        } else {
          next[draggedId] = targetGroupKey
        }
        try {
          localStorage.setItem('agent-workbench:dashboard-folder-overrides', JSON.stringify(next))
        } catch {}
        return next
      })

      // 2. 更新目標分組中的排序清單
      setCustomOrder((prev) => {
        const next: Record<string, string[]> = {}
        for (const [k, arr] of Object.entries(prev)) {
          next[k] = arr.filter((id) => id !== draggedId)
        }

        const currentGroupSessions =
          folderGroups.find((g) => g.key === targetGroupKey)?.sessions.map((s) => s.id) || []
        const existingOrder = next[targetGroupKey] || [...currentGroupSessions]
        const targetList = existingOrder.filter((id) => id !== draggedId)

        if (!targetId || position === 'inside') {
          targetList.push(draggedId)
        } else {
          const targetIdx = targetList.indexOf(targetId)
          if (targetIdx === -1) {
            targetList.push(draggedId)
          } else {
            const insertIdx = position === 'before' ? targetIdx : targetIdx + 1
            targetList.splice(insertIdx, 0, draggedId)
          }
        }

        next[targetGroupKey] = targetList
        try {
          localStorage.setItem('agent-workbench:dashboard-order', JSON.stringify(next))
        } catch {}
        return next
      })
    },
    [displayedSessions, folderGroups]
  )

  const toggleFolderCollapse = (key: string): void => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const handleCollapseAll = (): void => {
    setCollapsedFolders(new Set(folderGroups.map((g) => g.key)))
  }

  const handleExpandAll = (): void => {
    setCollapsedFolders(new Set())
  }

  return (
    <div className="dash-root">
      {/* Dashboard Header */}
      <div className="dash-header">
        <div className="dash-title-block">
          <h2 className="dash-title">{t('dashboard.telemetryTitle')}</h2>
          <span className="dash-subtitle">
            {lastRefreshed ? t('dashboard.updatedAt', { time: lastRefreshed }) : t('dashboard.analyzingSessions')}
          </span>
        </div>
        <button className="dash-refresh-btn" onClick={() => loadData(false)} disabled={loading} title={t('dashboard.refreshTooltip')}>
          <span className={loading ? 'dash-spinning' : ''}>↻</span>
        </button>
      </div>

      {/* Overview Metric Banner */}
      <div className="dash-banner">
        <div className="dash-banner-metric">
          <span className="dash-metric-label">{t('dashboard.workspaceTokens')}</span>
          <strong className="dash-metric-val">{data ? formatTokens(totalTokens) : '—'}</strong>
        </div>
        <div className="dash-banner-divider" />
        <div className="dash-banner-metric">
          <span className="dash-metric-label">{t('dashboard.activeProcesses')}</span>
          <strong className="dash-metric-val">{activeSessionsCount}</strong>
        </div>
        <div className="dash-banner-divider" />
        <div className="dash-banner-metric">
          <span className="dash-metric-label">{t('dashboard.totalSessions')}</span>
          <strong className="dash-metric-val">{allSessions.length}</strong>
        </div>
      </div>

      {/* Agent Usage Trio Cards (filtered by CLI settings) */}
      {enabledAgentIds.length === 0 ? (
        <div className="dash-no-agents-banner">
          <div className="dash-no-agents-content">
            <span className="dash-no-agents-icon">⚙️</span>
            <div className="dash-no-agents-text">
              <strong className="dash-no-agents-title">{t('dashboard.noAgentsEnabled')}</strong>
              <span className="dash-no-agents-desc">{t('dashboard.noAgentsEnabledDesc')}</span>
            </div>
          </div>
          <button
            type="button"
            className="dash-no-agents-btn"
            onClick={() => openSettings('cli')}
          >
            {t('sidebar.settings')} ➔
          </button>
        </div>
      ) : (
        <div className="dash-agents-grid">
          {enabledAgentIds.map((agentId) => {
            const cfg = AGENT_CONFIG[agentId]
            const usage = data?.agents[agentId]
            const activeCount = usage?.activeSessions ?? 0
            const agentTokens = usage?.totalTokens ?? 0
            const isSelected = selectedAgent === agentId

            const total = agentTokens || 1
            const promptTokens = usage?.promptTokens ?? 0
            const toolTokens = usage?.toolTokens ?? 0
            const completionTokens = usage?.completionTokens ?? 0

            const pctPrompt = Math.min(100, Math.round((promptTokens / total) * 100))
            const pctTools = Math.min(100, Math.round((toolTokens / total) * 100))
            const pctComp = Math.max(0, 100 - pctPrompt - pctTools)

            return (
              <div
                key={agentId}
                className={`dash-agent-card dash-agent-${agentId} ${isSelected ? 'selected' : ''}`}
                onClick={() => setSelectedAgent((prev) => (prev === agentId ? 'all' : agentId))}
                title={`Click to filter sessions by ${cfg.name} (Total: ${agentTokens.toLocaleString()} tokens)`}
              >
                <div className="dash-agent-head">
                  <div className="dash-agent-brand">
                    <AgentMark agent={agentId} size={18} />
                    <div className="dash-agent-meta">
                      <strong className="dash-agent-name">{cfg.name}</strong>
                      <span className="dash-agent-sessions">
                        {usage?.totalSessions ?? 0} {usage?.totalSessions === 1 ? t('dashboard.sessionSingular') : t('dashboard.sessionPlural')}
                      </span>
                    </div>
                  </div>
                  <div className="dash-agent-badges">
                    {activeCount > 0 && (
                      <span className="dash-active-pill" title={`${activeCount} active terminal session(s)`}>
                        <span className="dash-pulse-dot" /> {t('dashboard.activeCount', { count: activeCount })}
                      </span>
                    )}
                  </div>
                </div>

                {/* Total Tokens Display */}
                <div className="dash-agent-token-stat">
                  <div className="dash-agent-stat-number-row">
                    <span className="dash-agent-stat-number">{formatTokens(agentTokens)}</span>
                    <span className="dash-agent-stat-unit">{t('dashboard.totalTokensUnit')}</span>
                  </div>
                </div>

                {/* Segmented Token Distribution Bar */}
                <div
                  className="dash-agent-tokens-meter"
                  title={`Input: ${promptTokens.toLocaleString()} (${pctPrompt}%) | Tools: ${toolTokens.toLocaleString()} (${pctTools}%) | Out: ${completionTokens.toLocaleString()} (${pctComp}%)`}
                >
                  <div className="dash-agent-tokens-track">
                    <div
                      className="dash-agent-tokens-seg seg-prompt"
                      style={{ width: `${pctPrompt}%` }}
                    />
                    <div
                      className="dash-agent-tokens-seg seg-tools"
                      style={{ width: `${pctTools}%` }}
                    />
                    <div
                      className="dash-agent-tokens-seg seg-comp"
                      style={{ width: `${pctComp}%` }}
                    />
                  </div>
                </div>

                {/* Usage Breakdown 3-Column Grid */}
                <div className="dash-agent-breakdown-grid">
                  <div
                    className="dash-agent-breakdown-col"
                    title={`Input & Context Tokens: ${promptTokens.toLocaleString()} (${pctPrompt}%)`}
                  >
                    <div className="dash-agent-col-label">
                      <span className="dash-agent-chip-dot dot-prompt" />
                      <span>In</span>
                    </div>
                    <span className="dash-agent-col-val">{formatTokens(promptTokens)}</span>
                  </div>
                  <div
                    className="dash-agent-breakdown-col"
                    title={`Tool Execution & File Reads: ${toolTokens.toLocaleString()} (${pctTools}%)`}
                  >
                    <div className="dash-agent-col-label">
                      <span className="dash-agent-chip-dot dot-tools" />
                      <span>Tools</span>
                    </div>
                    <span className="dash-agent-col-val">{formatTokens(toolTokens)}</span>
                  </div>
                  <div
                    className="dash-agent-breakdown-col"
                    title={`Model Completion & Output: ${completionTokens.toLocaleString()} (${pctComp}%)`}
                  >
                    <div className="dash-agent-col-label">
                      <span className="dash-agent-chip-dot dot-comp" />
                      <span>Out</span>
                    </div>
                    <span className="dash-agent-col-val">{formatTokens(completionTokens)}</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Sessions & Token Breakdown Section */}
      <div className="dash-sessions-section">
        <div className="dash-section-header">
          <div className="dash-filter-segmented">
            <button
              className={viewFilter === 'all' ? 'active' : ''}
              onClick={() => setViewFilter('all')}
            >
              {t('dashboard.sessionsTab', { count: unarchivedSessions.length })}
            </button>
            <button
              className={viewFilter === 'archived' ? 'active' : ''}
              onClick={() => setViewFilter('archived')}
            >
              {t('dashboard.archivedTab', { count: archivedSessions.length })}
            </button>
          </div>

          <div className="dash-section-actions">
            {selectedAgent !== 'all' && (
              <button
                className="dash-active-filter-badge"
                onClick={() => setSelectedAgent('all')}
                title="Click to clear filter"
              >
                {t('dashboard.filterClear', { name: AGENT_CONFIG[selectedAgent].name })}
              </button>
            )}

            {folderGroups.length > 0 && (
              <div className="dash-folder-toggle-group">
                <button
                  type="button"
                  className="dash-folder-tool-btn"
                  onClick={handleExpandAll}
                  title={t('dashboard.expandAll')}
                  aria-label={t('dashboard.expandAll')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="7 11 12 6 17 11" />
                    <polyline points="7 18 12 13 17 18" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="dash-folder-tool-btn"
                  onClick={handleCollapseAll}
                  title={t('dashboard.collapseAll')}
                  aria-label={t('dashboard.collapseAll')}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="7 13 12 18 17 13" />
                    <polyline points="7 6 12 11 17 6" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        {displayedSessions.length === 0 ? (
          <div className="dash-empty-state">
            <div className="dash-empty-icon">{enabledAgentIds.length === 0 ? '⚙️' : '📋'}</div>
            <p className="dash-empty-title">
              {enabledAgentIds.length === 0
                ? t('dashboard.noAgentsEnabled')
                : viewFilter === 'archived'
                ? t('dashboard.noArchived')
                : t('dashboard.noSessions')}
            </p>
            <p className="dash-empty-desc">
              {enabledAgentIds.length === 0
                ? t('dashboard.noAgentsEnabledDesc')
                : viewFilter === 'archived'
                ? t('dashboard.noArchivedDesc')
                : t('dashboard.noSessionsDesc')}
            </p>
            {enabledAgentIds.length === 0 && (
              <button
                type="button"
                className="dash-no-agents-btn"
                style={{ marginTop: 12 }}
                onClick={() => openSettings('cli')}
              >
                {t('sidebar.settings')} ➔
              </button>
            )}
          </div>
        ) : (
          <div className="dash-session-list">
            {folderGroups.map((group) => {
              const isCollapsed = collapsedFolders.has(group.key)
              return (
                <div
                  key={group.key}
                  className={`dash-folder-group ${group.isCurrentWorkspace ? 'is-current' : ''} ${dragOverFolderKey === group.key ? 'drag-over-folder' : ''}`}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes('application/x-dashboard-session-id')) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      if (dragOverFolderKey !== group.key) {
                        setDragOverFolderKey(group.key)
                      }
                    }
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                      if (dragOverFolderKey === group.key) {
                        setDragOverFolderKey(null)
                      }
                    }
                  }}
                  onDrop={(e) => {
                    const draggedId = e.dataTransfer.getData('application/x-dashboard-session-id')
                    if (draggedId) {
                      e.preventDefault()
                      e.stopPropagation()
                      setDragOverFolderKey(null)
                      handleReorderSession(draggedId, null, 'inside', group.key)
                    }
                  }}
                >
                  <div
                    className={`dash-folder-header ${isCollapsed ? 'collapsed' : 'expanded'}`}
                    onClick={() => toggleFolderCollapse(group.key)}
                    title={`Click to ${isCollapsed ? 'expand' : 'collapse'} sessions in ${group.name}${group.path ? ` (${group.path})` : ''}`}
                  >
                    {/* Top Row: Chevron, Folder Icon, Name, and Total Tokens */}
                    <div className="dash-folder-top">
                      <div className="dash-folder-title-left">
                        <span className={`dash-folder-chevron ${isCollapsed ? '' : 'expanded'}`}>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <polyline points="9 18 15 12 9 6" />
                          </svg>
                        </span>
                        <span className="dash-folder-icon">
                          <IconFolder size={14} />
                        </span>
                        <strong className="dash-folder-name" title={group.path || group.name}>
                          {group.name}
                        </strong>
                        {group.isCurrentWorkspace && (
                          <span className="dash-folder-badge current">{t('dashboard.currentWorkspace')}</span>
                        )}
                      </div>
                      <span className="dash-folder-tokens" title={`${group.totalTokens.toLocaleString()} tokens`}>
                        {formatTokens(group.totalTokens)} {t('common.tokens')}
                      </span>
                    </div>

                    {/* Sub Row: Active indicator, Session count, and Switch Folder button */}
                    <div className="dash-folder-sub">
                      <div className="dash-folder-sub-left">
                        {group.activeCount > 0 && (
                          <span className="dash-folder-active-tag">
                            <span className="dash-pulse-dot" /> {t('dashboard.activeCount', { count: group.activeCount })}
                          </span>
                        )}
                        <span className="dash-folder-badge count">
                          {group.sessions.length} {group.sessions.length === 1 ? t('dashboard.sessionSingular') : t('dashboard.sessionPlural')}
                        </span>
                      </div>
                      {group.path && !group.isCurrentWorkspace && (
                        <button
                          type="button"
                          className="dash-folder-switch-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            if (group.path) {
                              switchWorkspace(group.path)
                            } else {
                              setSidebarTab('files')
                            }
                          }}
                          title={`${t('dashboard.switchFolder')}: ${group.path}`}
                        >
                          <span>{t('dashboard.switchFolder')} ➔</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {!isCollapsed && (
                    <div className="dash-folder-sessions">
                      {group.sessions.map((session: AgentSessionInfo) => (
                        <SessionCard
                          key={session.id}
                          session={session}
                          groupKey={group.key}
                          isExpanded={expandedSessionId === session.id}
                          onToggle={() => toggleExpand(session.id)}
                          onArchive={(e) => handleArchive(session.id, !session.isArchived, e)}
                          onDelete={(e) => handleDeletePrompt(session, e)}
                          onReorder={handleReorderSession}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Apple HIG Destructive Alert Dialog */}
      <AppleAlertDialog
        isOpen={Boolean(sessionToDelete)}
        title={t('dashboard.deleteDialogTitle')}
        description={t('dashboard.deleteDialogDesc')}
        confirmLabel={t('dashboard.deleteConfirm')}
        cancelLabel={t('common.cancel')}
        isDestructive={true}
        detail={
          sessionToDelete ? (
            <div className="dash-alert-session-preview">
              <div className="dash-alert-session-top">
                <div className="dash-alert-session-agent">
                  <AgentMark agent={sessionToDelete.agent} size={15} />
                  <span className="dash-alert-session-agent-name">
                    {AGENT_CONFIG[sessionToDelete.agent]?.name || sessionToDelete.agent}
                  </span>
                </div>
                <span className={`dash-status-badge ${sessionToDelete.status}`}>
                  {sessionToDelete.status === 'active'
                    ? t('dashboard.statusActive')
                    : sessionToDelete.status === 'waiting_approval'
                    ? t('dashboard.statusWaitingApproval')
                    : sessionToDelete.status === 'completed'
                    ? t('dashboard.statusCompleted')
                    : t('dashboard.statusIdle')}
                </span>
              </div>
              <div className="dash-alert-session-title" title={sessionToDelete.title}>
                {sessionToDelete.title}
              </div>
              <div className="dash-alert-session-meta">
                <span>ID: {sessionToDelete.id.slice(0, 8)}</span>
                {sessionToDelete.workspace && (
                  <>
                    <span>•</span>
                    <span className="dash-alert-workspace" title={sessionToDelete.workspacePath || sessionToDelete.workspace}>
                      <IconFolder size={11} />
                      <span>{sessionToDelete.workspace}</span>
                    </span>
                  </>
                )}
                <span>•</span>
                <span>{formatTokens(sessionToDelete.totalTokens)} tokens</span>
              </div>
            </div>
          ) : null
        }
        onConfirm={handleConfirmDelete}
        onClose={() => setSessionToDelete(null)}
      />
    </div>
  )
}

function SessionCard({
  session,
  isExpanded,
  onToggle,
  onArchive,
  onDelete,
  groupKey,
  onReorder
}: {
  session: AgentSessionInfo
  isExpanded: boolean
  onToggle: () => void
  onArchive: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
  groupKey: string
  onReorder: (
    draggedId: string,
    targetId: string | null,
    position: 'before' | 'after' | 'inside',
    targetGroupKey: string
  ) => void
}): JSX.Element {
  const { t } = useTranslation()
  const cfg = AGENT_CONFIG[session.agent]
  const { tokenBreakdown, totalTokens } = session
  const total = totalTokens || 1

  // Compute percentages for Apple Health-style meter
  const promptTokens = tokenBreakdown?.promptTokens ?? 0
  const toolTokens = tokenBreakdown?.toolReadTokens ?? 0
  const completionTokens = tokenBreakdown?.completionTokens ?? 0

  const pctPrompt = Math.min(100, Math.round((promptTokens / total) * 100))
  const pctTools = Math.min(100, Math.round((toolTokens / total) * 100))
  const pctComp = Math.max(0, 100 - pctPrompt - pctTools)

  const statusLabel =
    session.status === 'active'
      ? t('dashboard.statusActive')
      : session.status === 'waiting_approval'
      ? t('dashboard.statusWaitingApproval')
      : session.status === 'completed'
      ? t('dashboard.statusCompleted')
      : t('dashboard.statusIdle')

  const startTimeStr = new Date(session.startTime).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })

  const [isDragging, setIsDragging] = useState(false)
  const [dropIndicator, setDropIndicator] = useState<'top' | 'bottom' | null>(null)

  const handleOpenCli = (e: React.MouseEvent): void => {
    e.stopPropagation()
    openTerminalSession({
      id: session.id,
      agent: session.agent,
      title: session.title,
      status: session.status,
      ensureRightDock: true
    })
  }

  const handleWorkspaceClick = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    const targetPath = session.workspacePath
    if (targetPath) {
      await switchWorkspace(targetPath)
    } else {
      setSidebarTab('files')
    }
  }

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>): void => {
    setIsDragging(true)
    const sessionData = {
      type: 'agent-session' as const,
      id: session.id,
      agent: session.agent,
      title: session.title,
      status: session.status,
      workspace: session.workspace,
      workspacePath: session.workspacePath,
      model: session.model,
      totalTokens: session.totalTokens
    }
    setDraggedSession(sessionData)
    e.dataTransfer.setData('application/x-agent-session', JSON.stringify(sessionData))
    e.dataTransfer.setData('application/x-dashboard-session-id', session.id)
    e.dataTransfer.setData('application/x-dashboard-group-key', groupKey)
    e.dataTransfer.setData('text/plain', `[Session: @${session.agent}] ${session.title}`)
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const handleDragEnd = (): void => {
    setIsDragging(false)
    setDropIndicator(null)
    setDraggedSession(null)
  }

  const handleCardDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (isDragging) return
    if (e.dataTransfer.types.includes('application/x-dashboard-session-id')) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      const rect = e.currentTarget.getBoundingClientRect()
      const midY = rect.top + rect.height / 2
      const pos: 'top' | 'bottom' = e.clientY < midY ? 'top' : 'bottom'
      if (dropIndicator !== pos) {
        setDropIndicator(pos)
      }
    }
  }

  const handleCardDragLeave = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDropIndicator(null)
    }
  }

  const handleCardDrop = (e: React.DragEvent<HTMLDivElement>): void => {
    const draggedId = e.dataTransfer.getData('application/x-dashboard-session-id')
    if (draggedId) {
      e.preventDefault()
      e.stopPropagation()
      const pos = dropIndicator === 'top' ? 'before' : 'after'
      setDropIndicator(null)
      if (draggedId !== session.id) {
        onReorder(draggedId, session.id, pos, groupKey)
      }
    }
  }

  return (
    <div
      className={`dash-session-card status-${session.status} ${isDragging ? 'dragging' : ''} ${dropIndicator === 'top' ? 'drag-over-top' : ''} ${dropIndicator === 'bottom' ? 'drag-over-bottom' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleCardDragOver}
      onDragLeave={handleCardDragLeave}
      onDrop={handleCardDrop}
      title="Click to open CLI, drag to reorder/move folder, or drag to terminal to handoff"
    >
      <div className="dash-session-row">
        <div className="dash-drag-grip" title="Drag to reorder, move to another folder, or drag to terminal">
          <IconGripVertical size={13} />
        </div>

        <div
          className="dash-session-click-area"
          onClick={handleOpenCli}
          title={
            session.status === 'active'
              ? 'Click to switch to active CLI session in right terminal'
              : 'Click to open / resume this session in right terminal'
          }
        >
          <AgentMark agent={session.agent} size={18} />

          <div className="dash-session-main">
            <div className="dash-session-title-line">
              <strong className="dash-session-title" title={session.title}>
                {session.title}
              </strong>
              <span className={`dash-status-badge ${session.status}`}>{statusLabel}</span>
            </div>

            <div className="dash-session-meta-line">
              <span>{cfg.name}</span>
              {session.model && (
                <>
                  <span>•</span>
                  <span className="dash-meta-model">{session.model}</span>
                </>
              )}
              {session.workspace && (
                <>
                  <span>•</span>
                  <button
                    type="button"
                    className="dash-session-workspace"
                    onClick={handleWorkspaceClick}
                    title={
                      session.workspacePath
                        ? `${t('dashboard.switchFolder')}: ${session.workspacePath}`
                        : `${t('dashboard.switchFolder')}: ${session.workspace}`
                    }
                  >
                    <IconFolder size={11} />
                    <span>{session.workspace}</span>
                  </button>
                </>
              )}
              <span>•</span>
              <span>{startTimeStr}</span>
            </div>
          </div>
        </div>

        <div className="dash-session-right-col">
          <div
            className="dash-session-token-summary"
            onClick={onToggle}
            title="Click to toggle token breakdown"
          >
            <strong className="dash-token-amount">{formatTokens(totalTokens)}</strong>
            <span className="dash-token-unit">{t('common.tokens')}</span>
          </div>

          <button className="dash-expand-chevron" onClick={onToggle} title="Show token breakdown">
            {isExpanded ? '▲' : '▼'}
          </button>
        </div>
      </div>

      {/* Apple Health Segmented Token Meter Bar */}
      <div className="dash-meter-container" title="Token Consumption Distribution">
        <div className="dash-meter-bar">
          <div
            className="dash-meter-seg seg-prompt"
            style={{ width: `${pctPrompt}%` }}
            title={`Prompts & System Context: ${formatTokens(promptTokens)} (${pctPrompt}%)`}
          />
          <div
            className="dash-meter-seg seg-tools"
            style={{ width: `${pctTools}%` }}
            title={`Tool Execution & Files: ${formatTokens(toolTokens)} (${pctTools}%)`}
          />
          <div
            className="dash-meter-seg seg-comp"
            style={{ width: `${pctComp}%` }}
            title={`Thinking & Generation: ${formatTokens(completionTokens)} (${pctComp}%)`}
          />
        </div>
      </div>

      {/* Action Bar: Open in CLI, Archive & Delete */}
      <div className="dash-session-actions-bar">
        <button
          className="dash-action-btn dash-action-open"
          onClick={handleOpenCli}
          title={
            session.status === 'active'
              ? 'Switch to this active CLI terminal'
              : 'Open / Resume this session in right CLI terminal'
          }
        >
          <IconTerminalBox size={12} />
          <span>{session.status === 'active' ? t('dashboard.switchCli') : t('dashboard.resumeCli')}</span>
        </button>
        <div className="dash-session-actions-right">
          <button
            className="dash-action-btn dash-action-icon-btn"
            onClick={onArchive}
            title={session.isArchived ? t('dashboard.restore') : t('dashboard.archive')}
          >
            <IconArchive size={12} />
            <span className="dash-action-label">{session.isArchived ? t('dashboard.restore') : t('dashboard.archive')}</span>
          </button>
          <button
            className="dash-action-btn dash-action-delete dash-action-icon-btn"
            onClick={onDelete}
            title={t('dashboard.delete')}
          >
            <IconTrash size={12} />
            <span className="dash-action-label">{t('dashboard.delete')}</span>
          </button>
        </div>
      </div>

      {/* Expanded Token Breakdown Analysis */}
      {isExpanded && (
        <div className="dash-session-breakdown">
          {tokenBreakdown?.details && tokenBreakdown.details.length > 0 && (
            <div className="dash-breakdown-analysis">
              <span className="dash-analysis-badge">{t('dashboard.analysisBadge')}</span>
              <p className="dash-analysis-text">
                {tokenBreakdown.details
                  .map(
                    (d: { category: string; tokens: number; percentage: number }) => {
                      let catName = d.category
                      if (/context|系統|提示/i.test(catName)) catName = t('dashboard.categoryContext')
                      else if (/tool|檔案|代碼|工具/i.test(catName)) catName = t('dashboard.categoryTools')
                      else if (/thinking|推論|思考|回覆/i.test(catName)) catName = t('dashboard.categoryThinking')
                      return `${catName}: ${d.percentage}% (${formatTokens(d.tokens)})`
                    }
                  )
                  .join(' • ')}
              </p>
            </div>
          )}

          <div className="dash-breakdown-grid">
            <div className="dash-breakdown-pill">
              <span className="dash-pill-indicator seg-prompt" />
              <div className="dash-pill-text">
                <span className="dash-pill-label">{t('dashboard.contextPrompt')}</span>
                <strong>{formatTokens(promptTokens)} ({pctPrompt}%)</strong>
              </div>
            </div>

            <div className="dash-breakdown-pill">
              <span className="dash-pill-indicator seg-tools" />
              <div className="dash-pill-text">
                <span className="dash-pill-label">{t('dashboard.toolExecution')}</span>
                <strong>{formatTokens(toolTokens)} ({pctTools}%)</strong>
              </div>
            </div>

            <div className="dash-breakdown-pill">
              <span className="dash-pill-indicator seg-comp" />
              <div className="dash-pill-text">
                <span className="dash-pill-label">{t('dashboard.outputGeneration')}</span>
                <strong>{formatTokens(completionTokens)} ({pctComp}%)</strong>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
