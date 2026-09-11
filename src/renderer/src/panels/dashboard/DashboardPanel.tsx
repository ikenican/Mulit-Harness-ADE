import { useEffect, useState, useCallback } from 'react'
import type {
  DashboardData,
  AgentId,
  AgentSessionInfo,
  AgentUsageSummary
} from '../../../../preload/index'
import AgentMark from '@/components/AgentMark'
import { IconArchive, IconTrash, IconTerminalBox, IconFolder, IconGripVertical } from '@/components/Icons'
import AppleAlertDialog from '@/components/AppleAlertDialog'
import { openTerminalSession, setDraggedSession } from '@/store'
import './dashboard.css'

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

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const res = await window.api.dashboard.data()
      setData(res)
      setLastRefreshed(new Date().toLocaleTimeString())
    } catch (e) {
      console.error('Failed to load dashboard data:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 5000)
    return () => clearInterval(interval)
  }, [loadData])

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

  const agentList: AgentUsageSummary[] = data ? Object.values(data.agents) : []

  const totalTokens: number = agentList.reduce(
    (acc: number, a: AgentUsageSummary) => acc + a.totalTokens,
    0
  )

  const activeSessionsCount = data
    ? data.sessions.filter((s) => s.status === 'active').length
    : 0

  const allSessions = data?.sessions || []
  const archivedSessions = allSessions.filter((s) => s.isArchived)
  const unarchivedSessions = allSessions.filter((s) => !s.isArchived)
  const baseSessions = viewFilter === 'archived' ? archivedSessions : unarchivedSessions
  const displayedSessions =
    selectedAgent === 'all'
      ? baseSessions
      : baseSessions.filter((s) => s.agent === selectedAgent)

  return (
    <div className="dash-root">
      {/* Dashboard Header */}
      <div className="dash-header">
        <div className="dash-title-block">
          <h2 className="dash-title">Agent Telemetry & Usage</h2>
          <span className="dash-subtitle">
            {lastRefreshed ? `Updated ${lastRefreshed}` : 'Analyzing workspace sessions...'}
          </span>
        </div>
        <button className="dash-refresh-btn" onClick={loadData} disabled={loading} title="Refresh telemetry">
          <span className={loading ? 'dash-spinning' : ''}>↻</span>
        </button>
      </div>

      {/* Overview Metric Banner */}
      <div className="dash-banner">
        <div className="dash-banner-metric">
          <span className="dash-metric-label">Workspace Tokens</span>
          <strong className="dash-metric-val">{data ? formatTokens(totalTokens) : '—'}</strong>
        </div>
        <div className="dash-banner-divider" />
        <div className="dash-banner-metric">
          <span className="dash-metric-label">Active Processes</span>
          <strong className="dash-metric-val">{activeSessionsCount}</strong>
        </div>
        <div className="dash-banner-divider" />
        <div className="dash-banner-metric">
          <span className="dash-metric-label">Total Sessions</span>
          <strong className="dash-metric-val">{data ? data.sessions.length : 0}</strong>
        </div>
      </div>

      {/* Agent Usage Trio Cards */}
      <div className="dash-agents-grid">
        {(['claude', 'antigravity', 'codex'] as AgentId[]).map((agentId) => {
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
                      {usage?.totalSessions ?? 0} sessions
                    </span>
                  </div>
                </div>
                <div className="dash-agent-badges">
                  {activeCount > 0 && (
                    <span className="dash-active-pill" title={`${activeCount} active terminal session(s)`}>
                      <span className="dash-pulse-dot" /> {activeCount} active
                    </span>
                  )}
                </div>
              </div>

              {/* Total Tokens Display */}
              <div className="dash-agent-token-stat">
                <div className="dash-agent-stat-number-row">
                  <span className="dash-agent-stat-number">{formatTokens(agentTokens)}</span>
                  <span className="dash-agent-stat-unit">total tokens</span>
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

      {/* Sessions & Token Breakdown Section */}
      <div className="dash-sessions-section">
        <div className="dash-section-header">
          <div className="dash-filter-segmented">
            <button
              className={viewFilter === 'all' ? 'active' : ''}
              onClick={() => setViewFilter('all')}
            >
              Sessions ({unarchivedSessions.length})
            </button>
            <button
              className={viewFilter === 'archived' ? 'active' : ''}
              onClick={() => setViewFilter('archived')}
            >
              Archived ({archivedSessions.length})
            </button>
          </div>

          {selectedAgent !== 'all' && (
            <button
              className="dash-active-filter-badge"
              onClick={() => setSelectedAgent('all')}
              title="Click to clear filter"
            >
              Filtered: {AGENT_CONFIG[selectedAgent].name} ✕
            </button>
          )}
        </div>

        {displayedSessions.length === 0 ? (
          <div className="dash-empty-state">
            <div className="dash-empty-icon">📋</div>
            <p className="dash-empty-title">
              {viewFilter === 'archived' ? 'No archived sessions' : 'No active session records'}
            </p>
            <p className="dash-empty-desc">
              {viewFilter === 'archived'
                ? 'Sessions you archive will appear here.'
                : 'Launch Claude, Antigravity, or Codex from the Agent Terminals. Live token consumption will stream here.'}
            </p>
          </div>
        ) : (
          <div className="dash-session-list">
            {displayedSessions.map((session: AgentSessionInfo) => (
              <SessionCard
                key={session.id}
                session={session}
                isExpanded={expandedSessionId === session.id}
                onToggle={() => toggleExpand(session.id)}
                onArchive={(e) => handleArchive(session.id, !!session.isArchived, e)}
                onDelete={(e) => handleDeletePrompt(session, e)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Apple HIG Destructive Alert Dialog */}
      <AppleAlertDialog
        isOpen={Boolean(sessionToDelete)}
        title="Delete Session Record?"
        description="This will permanently delete this session's telemetry and token metrics from the dashboard. This action cannot be undone."
        confirmLabel="Delete Record"
        cancelLabel="Cancel"
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
                  {sessionToDelete.status}
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
  onDelete
}: {
  session: AgentSessionInfo
  isExpanded: boolean
  onToggle: () => void
  onArchive: (e: React.MouseEvent) => void
  onDelete: (e: React.MouseEvent) => void
}): JSX.Element {
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
      ? 'Active'
      : session.status === 'waiting_approval'
      ? 'Needs Approval'
      : session.status === 'completed'
      ? 'Completed'
      : 'Idle'

  const startTimeStr = new Date(session.startTime).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })

  const [isDragging, setIsDragging] = useState(false)

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
    e.dataTransfer.setData('text/plain', `[Session: @${session.agent}] ${session.title}`)
    e.dataTransfer.effectAllowed = 'copyMove'
  }

  const handleDragEnd = (): void => {
    setIsDragging(false)
    setDraggedSession(null)
  }

  return (
    <div
      className={`dash-session-card status-${session.status} ${isDragging ? 'dragging' : ''}`}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      title="Click to open CLI, or drag to right terminal to open / handoff"
    >
      <div className="dash-session-row">
        <div className="dash-drag-grip" title="Drag to Terminal to open or handoff">
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
                  <span
                    className="dash-session-workspace"
                    title={session.workspacePath ? `Workspace: ${session.workspacePath}` : `Workspace: ${session.workspace}`}
                  >
                    <IconFolder size={11} />
                    <span>{session.workspace}</span>
                  </span>
                </>
              )}
              <span>•</span>
              <span>{startTimeStr}</span>
            </div>
          </div>
        </div>

        <div
          className="dash-session-token-summary"
          onClick={onToggle}
          title="Click to toggle token breakdown"
        >
          <strong className="dash-token-amount">{formatTokens(totalTokens)}</strong>
          <span className="dash-token-unit">tokens</span>
        </div>

        <button className="dash-expand-chevron" onClick={onToggle} title="Show token breakdown">
          {isExpanded ? '▲' : '▼'}
        </button>
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
          <span>{session.status === 'active' ? 'Switch CLI ➔' : 'Resume CLI ➔'}</span>
        </button>
        <div className="dash-session-actions-right">
          <button
            className="dash-action-btn"
            onClick={onArchive}
            title={session.isArchived ? 'Restore to active list' : 'Archive session'}
          >
            <IconArchive size={12} />
            <span>{session.isArchived ? 'Restore' : 'Archive'}</span>
          </button>
          <button
            className="dash-action-btn dash-action-delete"
            onClick={onDelete}
            title="Delete session record"
          >
            <IconTrash size={12} />
            <span>Delete</span>
          </button>
        </div>
      </div>

      {/* Expanded Token Breakdown Analysis */}
      {isExpanded && (
        <div className="dash-session-breakdown">
          {tokenBreakdown?.details && tokenBreakdown.details.length > 0 && (
            <div className="dash-breakdown-analysis">
              <span className="dash-analysis-badge">ANALYSIS</span>
              <p className="dash-analysis-text">
                {tokenBreakdown.details
                  .map(
                    (d: { category: string; tokens: number; percentage: number }) =>
                      `${d.category}: ${d.percentage}% (${formatTokens(d.tokens)})`
                  )
                  .join(' • ')}
              </p>
            </div>
          )}

          <div className="dash-breakdown-grid">
            <div className="dash-breakdown-pill">
              <span className="dash-pill-indicator seg-prompt" />
              <div className="dash-pill-text">
                <span className="dash-pill-label">Context & Prompts</span>
                <strong>{formatTokens(promptTokens)} ({pctPrompt}%)</strong>
              </div>
            </div>

            <div className="dash-breakdown-pill">
              <span className="dash-pill-indicator seg-tools" />
              <div className="dash-pill-text">
                <span className="dash-pill-label">Tool Execution</span>
                <strong>{formatTokens(toolTokens)} ({pctTools}%)</strong>
              </div>
            </div>

            <div className="dash-breakdown-pill">
              <span className="dash-pill-indicator seg-comp" />
              <div className="dash-pill-text">
                <span className="dash-pill-label">Output Generation</span>
                <strong>{formatTokens(completionTokens)} ({pctComp}%)</strong>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
