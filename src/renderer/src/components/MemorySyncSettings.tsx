import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import { pasteInNewShell } from '@/store'
import { IconShield, IconRefresh, IconFolder } from './Icons'
import type { MemSyncResult, MemSyncState } from '../../../preload/index'

// 設定 → 記憶同步：把專案記憶（.project-memory）放進使用者自己的私人 GitHub repo。
// 流程：同意 → 安裝／登入 GitHub CLI → 建立或連結私人 repo → 把這個專案接上去 → 同步。
// 這一頁的動作立即生效（不經過底部的「儲存」），因為它們會動到 GitHub 與檔案。

type Busy = null | 'consent' | 'repo' | 'link' | 'sync' | 'refresh'

export default function MemorySyncSettings(): JSX.Element {
  const { t } = useTranslation()
  const [st, setSt] = useState<MemSyncState | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [repoName, setRepoName] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const errorText = (code: string, fallback: string): string => {
    const key = `memsync.err.${code}`
    const s = t(key)
    return s === key ? fallback : s
  }

  /** 執行一個動作：結果帶回新狀態就更新，失敗顯示原因 */
  const act = useCallback(
    async <T,>(which: Busy, fn: () => Promise<MemSyncResult<T>>, onOk?: (data: T) => string | null): Promise<void> => {
      setBusy(which)
      setMessage(null)
      try {
        const r = await fn()
        if (!r.ok) {
          setMessage({ kind: 'error', text: errorText(r.code, r.message) })
          return
        }
        const data = r.data as unknown as { state?: MemSyncState } & MemSyncState
        if (data && 'state' in data && data.state) setSt(data.state)
        else if (data && 'config' in data) setSt(data as MemSyncState)
        const note = onOk?.(r.data)
        if (note) setMessage({ kind: 'ok', text: note })
      } finally {
        setBusy(null)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  const refresh = useCallback(() => act('refresh', () => window.api.memsync.state()), [act])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (st && !repoName) setRepoName(st.config.repo)
  }, [st, repoName])

  if (!st) return <div className="macos-settings-body"><p className="remote-note">{t('common.loading')}</p></div>

  const consented = !!st.config.consentAt
  const p = st.project

  const setConsent = (on: boolean): Promise<void> => act('consent', () => window.api.memsync.setConfig({ consent: on }))

  const setupRepo = async (): Promise<void> => {
    if (repoName.trim() && repoName.trim() !== st.config.repo) {
      const r = await window.api.memsync.setConfig({ repo: repoName.trim() })
      if (!r.ok) return setMessage({ kind: 'error', text: errorText(r.code, r.message) })
    }
    await act('repo', () => window.api.memsync.setupRepo(), (d) =>
      t(d.result.created ? 'memsync.repoCreated' : 'memsync.repoLinked', { repo: d.result.repo })
    )
  }

  const link = async (): Promise<void> => {
    if (!p) return
    const lines = [
      p.hasRemoteMemory ? t('memsync.confirmFromRepo', { key: p.key }) : t('memsync.confirmMove', { key: p.key }),
      p.hasLocalMemory ? t('memsync.confirmBackup') : '',
      p.tracked.length ? t('memsync.confirmUntrack', { n: p.tracked.length }) : ''
    ].filter(Boolean)
    if (!window.confirm(lines.join('\n\n'))) return
    await act('link', () => window.api.memsync.linkProject(), (d) =>
      [
        t(d.result.source === 'local' ? 'memsync.linkedMoved' : d.result.source === 'repo' ? 'memsync.linkedFromRepo' : 'memsync.linkedAlready'),
        d.result.projectCommit ? t('memsync.projectCommit', { hash: d.result.projectCommit }) : ''
      ].filter(Boolean).join(' ')
    )
  }

  // 同步回報衝突時是「成功回傳但帶 error」，不能交給 act 當成功顯示，所以另外處理
  const syncWithConflict = async (): Promise<void> => {
    setBusy('sync')
    setMessage(null)
    try {
      const r = await window.api.memsync.sync(false)
      if (!r.ok) return setMessage({ kind: 'error', text: errorText(r.code, r.message) })
      setSt(r.data.state)
      if (r.data.result.error) setMessage({ kind: 'error', text: t('memsync.syncConflict', { detail: r.data.result.error }) })
      else setMessage({ kind: 'ok', text: t('memsync.synced', { pushed: r.data.result.pushed ? t('memsync.syncPushed') : t('memsync.syncNothingToPush') }) })
    } finally {
      setBusy(null)
    }
  }

  const stepState = (done: boolean): string => (done ? '#16A34A' : '#64748B')

  return (
    <div className="macos-settings-body">
      {/* 說明與同意 */}
      <div className="macos-section">
        <div className="macos-inset-group">
          <div className="macos-row">
            <div className="macos-row-main">
              <div className="macos-row-left">
                <div className="macos-row-badge-icon" style={{ background: stepState(consented) }}>
                  <IconShield size={14} />
                </div>
                <div className="macos-row-info">
                  <div className="macos-row-title-row">
                    <span className="macos-row-title">{t('memsync.consentTitle')}</span>
                    <span className="macos-type-pill">{consented ? t('memsync.on') : t('memsync.off')}</span>
                  </div>
                  <span className="macos-row-sub">{t('memsync.consentSub')}</span>
                </div>
              </div>
              <div className="macos-row-right">
                <label className="apple-toggle">
                  <input type="checkbox" disabled={busy !== null} checked={consented} onChange={(e) => void setConsent(e.target.checked)} />
                  <span className="apple-toggle-slider" />
                </label>
              </div>
            </div>
          </div>
        </div>
        <div className="remote-notes">
          <p className="remote-note">{t('memsync.explain1')}</p>
          <p className="remote-note">{t('memsync.explain2')}</p>
          <p className="remote-note">{t('memsync.explain3')}</p>
          <p className="remote-note warn">
            <IconShield size={12} /> {t('memsync.explainPrivacy')}
          </p>
        </div>
      </div>

      {st.gitMissing && <p className="remote-note danger">⚠️ {t('memsync.err.git-missing')}</p>}

      {consented && !st.gitMissing && (
        <>
          {/* 1. GitHub CLI */}
          <div className="macos-section">
            <span className="macos-section-header">{t('memsync.step1')}</span>
            <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
              <p className="macos-row-sub" style={{ marginTop: 0 }}>
                {!st.gh.installed
                  ? t('memsync.ghMissing')
                  : st.gh.loggedIn
                    ? t('memsync.ghLoggedIn', { login: st.gh.login || '' })
                    : t('memsync.ghNotLoggedIn')}
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!st.gh.installed && (
                  <button type="button" className="macos-btn-secondary" onClick={() => pasteInNewShell(st.commands.installGh, st.commands.shell)}>
                    {t('memsync.installGh')}
                  </button>
                )}
                {st.gh.installed && !st.gh.loggedIn && (
                  <button type="button" className="macos-btn-secondary" onClick={() => pasteInNewShell(st.commands.loginGh, st.commands.shell)}>
                    {t('memsync.loginGh')}
                  </button>
                )}
                <button type="button" className="macos-btn-secondary" disabled={busy !== null} onClick={() => void refresh()}>
                  <IconRefresh size={12} /> {t('memsync.recheck')}
                </button>
              </div>
              {(!st.gh.installed || !st.gh.loggedIn) && <p className="remote-note">{t('memsync.pastedHint')}</p>}
            </div>
          </div>

          {/* 2. 私人 repo */}
          <div className="macos-section">
            <span className="macos-section-header">{t('memsync.step2')}</span>
            <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
              {st.clone.exists ? (
                <p className="macos-row-sub" style={{ marginTop: 0 }}>
                  {t('memsync.cloneReady', { repo: st.config.repoFull || st.clone.origin || '', path: st.config.clonePath })}
                </p>
              ) : (
                <>
                  <label className="macos-row-sub" htmlFor="memsync-repo" style={{ display: 'block', marginBottom: 6 }}>
                    {t('memsync.repoNameLabel', { login: st.gh.login || '<you>' })}
                  </label>
                  <input
                    id="memsync-repo"
                    className="macos-input"
                    value={repoName}
                    onChange={(e) => setRepoName(e.target.value)}
                    disabled={busy !== null}
                    spellCheck={false}
                  />
                  <p className="remote-note">{t('memsync.clonePathNote', { path: st.config.clonePath })}</p>
                </>
              )}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {!st.clone.exists && (
                  <button type="button" className="macos-btn-primary" disabled={busy !== null || !st.gh.loggedIn} onClick={() => void setupRepo()}>
                    {busy === 'repo' ? t('memsync.working') : t('memsync.setupRepo')}
                  </button>
                )}
                {st.clone.exists && (
                  <button type="button" className="macos-btn-secondary" onClick={() => void window.api.memsync.openClone()}>
                    <IconFolder size={12} /> {t('memsync.openClone')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 3. 這個專案 */}
          <div className="macos-section">
            <span className="macos-section-header">{t('memsync.step3')}</span>
            <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
              {!p ? (
                <p className="macos-row-sub" style={{ margin: 0 }}>{t('memsync.notGitRepo')}</p>
              ) : (
                <>
                  <p className="macos-row-sub" style={{ marginTop: 0 }}>
                    {t('memsync.projectKey', { key: p.key })}{' '}
                    {p.linked
                      ? t('memsync.projectLinked')
                      : p.linkedElsewhere
                        ? t('memsync.projectLinkedElsewhere')
                        : p.hasRemoteMemory
                          ? t('memsync.projectRemoteOnly')
                          : p.hasLocalMemory
                            ? t('memsync.projectLocalOnly')
                            : t('memsync.projectNoMemory')}
                  </p>
                  {p.linked && p.tracked.length > 0 && <p className="remote-note danger">⚠️ {t('memsync.stillTracked', { n: p.tracked.length })}</p>}
                  {st.clone.exists && !p.linkedElsewhere && (p.hasLocalMemory || p.hasRemoteMemory || (p.linked && p.tracked.length > 0)) && (
                    <button type="button" className="macos-btn-primary" disabled={busy !== null} onClick={() => void link()}>
                      {busy === 'link'
                        ? t('memsync.working')
                        : p.linked
                          ? t('memsync.untrackNow')
                          : p.hasRemoteMemory
                            ? t('memsync.linkFromRepo')
                            : t('memsync.moveToRepo')}
                    </button>
                  )}
                  {!st.clone.exists && <p className="remote-note">{t('memsync.needRepoFirst')}</p>}
                </>
              )}
            </div>
          </div>

          {/* 4. 同步 */}
          {st.clone.exists && (
            <div className="macos-section">
              <span className="macos-section-header">{t('memsync.step4')}</span>
              <div className="macos-inset-group">
                <div className="macos-row">
                  <div className="macos-row-main">
                    <div className="macos-row-left">
                      <div className="macos-row-info">
                        <span className="macos-row-title">{t('memsync.autoPull')}</span>
                        <span className="macos-row-sub">{t('memsync.autoPullSub')}</span>
                      </div>
                    </div>
                    <div className="macos-row-right">
                      <label className="apple-toggle">
                        <input
                          type="checkbox"
                          disabled={busy !== null}
                          checked={st.config.autoPull}
                          onChange={(e) => void act('consent', () => window.api.memsync.setConfig({ autoPull: e.target.checked }))}
                        />
                        <span className="apple-toggle-slider" />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                <button type="button" className="macos-btn-primary" disabled={busy !== null} onClick={() => void syncWithConflict()}>
                  {busy === 'sync' ? t('memsync.working') : t('memsync.syncNow')}
                </button>
                <span className="macos-row-sub">
                  {t('memsync.cloneCounts', { ahead: st.clone.ahead ?? 0, behind: st.clone.behind ?? 0 })}
                  {st.clone.dirty ? ` · ${t('memsync.cloneDirty')}` : ''}
                </span>
              </div>
              <p className="remote-note">{t('memsync.handoffNote')}</p>
            </div>
          )}
        </>
      )}

      {message && <p className={`remote-note ${message.kind === 'error' ? 'danger' : ''}`}>{message.kind === 'error' ? '⚠️ ' : '✓ '}{message.text}</p>}
    </div>
  )
}
