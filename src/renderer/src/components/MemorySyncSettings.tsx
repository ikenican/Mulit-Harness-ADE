import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/i18n'
import { pasteInNewShell } from '@/store'
import { IconShield, IconRefresh, IconFolder } from './Icons'
import type { MemSyncBackend, MemSyncResult, MemSyncState } from '../../../preload/index'

// 設定 → 記憶同步：把專案記憶（.project-memory）放進使用者自己的私人 GitHub repo，
// 或 OneDrive／Google Drive 同步的資料夾。
// 流程：同意 → 選存放方式 → （GitHub：安裝／登入 gh、建立 repo；雲端硬碟：選資料夾）→ 接上專案 → 自動同步。
// 這一頁的動作立即生效（不經過底部的「儲存」），因為它們會動到檔案與雲端。

type Busy = null | 'config' | 'repo' | 'auto' | 'folder' | 'link' | 'sync' | 'refresh' | 'launch'
const BACKENDS: MemSyncBackend[] = ['github', 'onedrive', 'gdrive']

export default function MemorySyncSettings(): JSX.Element {
  const { t } = useTranslation()
  const [st, setSt] = useState<MemSyncState | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [repoName, setRepoName] = useState('')
  const [repoUrl, setRepoUrl] = useState('')
  const [route, setRoute] = useState<'gh' | 'url' | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // useTranslation 每次 render 都給新的 t；放進 ref，讓 act／refresh 保持穩定，
  // 否則開頁的 refresh effect 會每次 render 重跑（不停重新偵測 git／gh，訊息也被清掉）
  const tRef = useRef(t)
  tRef.current = t
  const errorText = useCallback((code: string, fallback: string): string => {
    const key = `memsync.err.${code}`
    const s = tRef.current(key, { message: fallback })
    return s === key ? fallback : s
  }, [])

  /** 執行一個動作：回傳帶新狀態就更新，失敗顯示原因；onOk 回傳要顯示的成功訊息 */
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
        const data = r.data as unknown as ({ state?: MemSyncState } & Partial<MemSyncState>) | null
        if (data?.state) setSt(data.state)
        else if (data && 'config' in data) setSt(data as MemSyncState)
        const note = onOk?.(r.data)
        if (note) setMessage({ kind: 'ok', text: note })
      } finally {
        setBusy(null)
      }
    },
    [errorText]
  )

  const refresh = useCallback(() => act('refresh', () => window.api.memsync.state()), [act])
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (st && !repoName) setRepoName(st.config.repo)
  }, [st, repoName])

  if (!st) return <div className="macos-settings-body"><p className="remote-note">{t('common.loading')}</p></div>

  const c = st.config
  // 只是在重新讀取狀態時不停用按鈕：第一次開頁偵測 git／gh 要幾秒，那段時間的點擊不該被吞掉
  const acting = busy !== null && busy !== 'refresh'
  const consented = !!c.consentAt
  const backend = c.backend
  const isFolder = backend === 'onedrive' || backend === 'gdrive'
  const p = st.project
  // 連結方式：沒選過時，有裝 gh 就走 gh，沒裝就走貼網址（免安裝）
  const ghRoute = route ?? (st.gh.installed ? 'gh' : 'url')
  // 一鍵建立只要 repo 名稱（設定裡可能存成 owner/repo）
  const lazyName = repoName.split('/').pop() || ''
  const providerName = (b: MemSyncBackend): string => t(`memsync.backend_${b}`)

  const setupRepo = async (): Promise<void> => {
    if (repoName.trim() && repoName.trim() !== c.repo) {
      const r = await window.api.memsync.setConfig({ repo: repoName.trim() })
      if (!r.ok) return setMessage({ kind: 'error', text: errorText(r.code, r.message) })
    }
    await act('repo', () => window.api.memsync.setupRepo(), (d) =>
      t(d.result.created ? 'memsync.repoCreated' : 'memsync.repoLinked', { repo: d.result.repo })
    )
  }

  // prefer：本機與共用的記憶內容不同時，使用者選用哪一份
  const link = async (prefer?: 'shared' | 'local'): Promise<void> => {
    if (!p) return
    const lines = [
      p.linkedToOldStore
        ? t('memsync.confirmMigrate', { key: p.key, from: p.linkedTo || '' })
        : prefer === 'local'
          ? t('memsync.confirmUseLocal', { key: p.key })
          : p.hasRemoteMemory
            ? t('memsync.confirmFromStore', { key: p.key })
            : t('memsync.confirmMove', { key: p.key }),
      p.hasLocalMemory || p.linkedToOldStore ? t('memsync.confirmBackup') : '',
      p.tracked.length ? t('memsync.confirmUntrack', { n: p.tracked.length, branch: p.branch || 'HEAD' }) : ''
    ].filter(Boolean)
    if (!window.confirm(lines.join('\n\n'))) return
    await act('link', () => window.api.memsync.linkProject(prefer), (d) =>
      [
        t(d.result.source === 'local' ? 'memsync.linkedMoved' : d.result.source === 'repo' ? 'memsync.linkedFromStore' : 'memsync.linkedAlready'),
        d.result.projectCommit ? t('memsync.projectCommit', { hash: d.result.projectCommit }) : ''
      ]
        .filter(Boolean)
        .join(' ')
    )
  }

  // 同步回報衝突時是「成功回傳但帶 error」，不能當成功顯示，所以另外處理
  const syncNow = async (): Promise<void> => {
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

  const toggleRow = (title: string, sub: string, checked: boolean, onChange: (v: boolean) => void): JSX.Element => (
    <div className="macos-row">
      <div className="macos-row-main">
        <div className="macos-row-left">
          <div className="macos-row-info">
            <span className="macos-row-title">{title}</span>
            <span className="macos-row-sub">{sub}</span>
          </div>
        </div>
        <div className="macos-row-right">
          <label className="apple-toggle">
            <input type="checkbox" disabled={acting} checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span className="apple-toggle-slider" />
          </label>
        </div>
      </div>
    </div>
  )

  let step = 1
  return (
    <div className="macos-settings-body">
      {/* 說明與同意 */}
      <div className="macos-section">
        <div className="macos-inset-group">
          <div className="macos-row">
            <div className="macos-row-main">
              <div className="macos-row-left">
                <div className="macos-row-badge-icon" style={{ background: consented ? '#16A34A' : '#64748B' }}>
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
                  <input
                    type="checkbox"
                    disabled={acting}
                    checked={consented}
                    onChange={(e) => void act('config', () => window.api.memsync.setConfig({ consent: e.target.checked }))}
                  />
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
            <IconShield size={12} /> {consented ? t('memsync.explainOn') : t('memsync.explainOff')}
          </p>
        </div>
      </div>

      {st.gitMissing && <p className="remote-note danger">⚠️ {t('memsync.err.git-missing')}</p>}

      {!st.memoryPlugin && (
        <div className="remote-note warn" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 260px' }}>⚠️ {t('memsync.pluginMissing')}</span>
          <button type="button" className="macos-btn-secondary" onClick={() => pasteInNewShell(st.commands.installPlugin, st.commands.shell)}>
            {t('memsync.installPlugin')}
          </button>
        </div>
      )}

      {consented && !st.gitMissing && (
        <>
          {/* 存放方式 */}
          <div className="macos-section">
            <span className="macos-section-header">{t('memsync.stepStorage', { n: step++ })}</span>
            <div className="macos-inset-group" style={{ padding: '14px 16px' }}>
              <div className="macos-lang-cards">
                {BACKENDS.map((b) => {
                  const detected = b === 'github' ? true : st.cloudRoots[b].length > 0
                  return (
                    <button
                      key={b}
                      type="button"
                      className={`macos-lang-card ${backend === b ? 'active' : ''}`}
                      disabled={acting}
                      onClick={() => {
                        if (b === backend) return
                        if (st.rootReady && !window.confirm(t('memsync.backendSwitchConfirm', { from: backend ? providerName(backend) : '', to: providerName(b) }))) return
                        void act('config', () => window.api.memsync.setConfig({ backend: b }))
                      }}
                    >
                      <div className="macos-lang-info">
                        <span className="macos-lang-name">{providerName(b)}</span>
                        <span className="macos-lang-sub">
                          {b === 'github'
                            ? t('memsync.backendGithubSub')
                            : detected
                              ? t('memsync.backendFolderSub')
                              : st.cloudApps[b].installed
                                ? t('memsync.backendNotSignedIn')
                                : t('memsync.backendNotFound')}
                        </span>
                      </div>
                      <span className="macos-radio-dot" />
                    </button>
                  )
                })}
              </div>
              {st.rootReady && <p className="remote-note">{t('memsync.backendSwitchNote')}</p>}
            </div>
          </div>

          {/* GitHub：gh 與私人 repo */}
          {backend === 'github' && (
            <>
              {!st.rootReady && (
                <div className="macos-section">
                  <span className="macos-section-header">{t('memsync.stepRoute', { n: step++ })}</span>
                  <div className="macos-inset-group" style={{ padding: '14px 16px' }}>
                    <div className="macos-lang-cards">
                      {(['gh', 'url'] as const).map((r) => (
                        <button key={r} type="button" className={`macos-lang-card ${ghRoute === r ? 'active' : ''}`} disabled={acting} onClick={() => setRoute(r)}>
                          <div className="macos-lang-info">
                            <span className="macos-lang-name">{t(r === 'gh' ? 'memsync.routeGh' : 'memsync.routeUrl')}</span>
                            <span className="macos-lang-sub">{t(r === 'gh' ? 'memsync.routeGhSub' : 'memsync.routeUrlSub')}</span>
                          </div>
                          <span className="macos-radio-dot" />
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {!st.rootReady && ghRoute === 'url' && (
                <div className="macos-section">
                  <span className="macos-section-header">{t('memsync.stepRepoUrl', { n: step++ })}</span>
                  <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
                    {/* 一鍵：用 Git 的 GitHub 登入直接建立私人 repo */}
                    <p className="macos-row-sub" style={{ marginTop: 0 }}>{t('memsync.autoIntro')}</p>
                    <label className="macos-row-sub" htmlFor="memsync-repo-auto" style={{ display: 'block', marginBottom: 6 }}>
                      {t('memsync.autoNameLabel')}
                    </label>
                    <input id="memsync-repo-auto" className="macos-input" value={lazyName} onChange={(e) => setRepoName(e.target.value)} disabled={acting} spellCheck={false} />
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0' }}>
                      <button
                        type="button"
                        className="macos-btn-primary"
                        disabled={acting || !lazyName.trim()}
                        onClick={() =>
                          void act('auto', () => window.api.memsync.createRepoViaGit(lazyName.trim()), (d) =>
                            t(d.result.created ? 'memsync.repoCreated' : 'memsync.repoLinked', { repo: d.result.repo })
                          )
                        }
                      >
                        {busy === 'auto' ? t('memsync.urlConnecting') : t('memsync.autoCreate')}
                      </button>
                    </div>
                    <p className="remote-note">{t('memsync.urlLoginHint')}</p>

                    {/* 備用：網頁上建立（名稱與 Private 已預填），貼回網址 */}
                    <p className="macos-row-sub" style={{ marginTop: 14 }}>{t('memsync.urlIntro')}</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                      <button
                        type="button"
                        className="macos-btn-secondary"
                        onClick={() =>
                          window.open(`https://github.com/new?name=${encodeURIComponent(lazyName.trim() || 'ai-project-memory')}&visibility=private`, '_blank')
                        }
                      >
                        {t('memsync.openGithubNew')}
                      </button>
                    </div>
                    <label className="macos-row-sub" htmlFor="memsync-repo-url" style={{ display: 'block', marginBottom: 6 }}>
                      {t('memsync.repoUrlLabel')}
                    </label>
                    <input
                      id="memsync-repo-url"
                      className="macos-input"
                      value={repoUrl}
                      placeholder={`https://github.com/<you>/${c.repo.split('/').pop() || 'ai-project-memory'}`}
                      onChange={(e) => setRepoUrl(e.target.value)}
                      disabled={acting}
                      spellCheck={false}
                    />
                    <p className="remote-note">{t('memsync.clonePathNote', { path: c.clonePath })}</p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="macos-btn-primary"
                        disabled={acting || !repoUrl.trim()}
                        onClick={() =>
                          void act('repo', () => window.api.memsync.connectRepo(repoUrl.trim()), (d) => t('memsync.repoLinked', { repo: d.result.repo }))
                        }
                      >
                        {busy === 'repo' ? t('memsync.urlConnecting') : t('memsync.connectRepo')}
                      </button>
                    </div>
                    <p className="remote-note">{t('memsync.urlLoginHint')}</p>
                  </div>
                </div>
              )}

              {!st.rootReady && ghRoute === 'gh' && (
              <div className="macos-section">
                <span className="macos-section-header">{t('memsync.stepGh', { n: step++ })}</span>
                <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
                  <p className="macos-row-sub" style={{ marginTop: 0 }}>
                    {!st.gh.installed ? t('memsync.ghMissing') : st.gh.loggedIn ? t('memsync.ghLoggedIn', { login: st.gh.login || '' }) : t('memsync.ghNotLoggedIn')}
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
                    <button type="button" className="macos-btn-secondary" disabled={acting} onClick={() => void refresh()}>
                      <IconRefresh size={12} /> {t('memsync.recheck')}
                    </button>
                  </div>
                  {(!st.gh.installed || !st.gh.loggedIn) && <p className="remote-note">{t('memsync.pastedHint')}</p>}
                </div>
              </div>
              )}

              {(st.rootReady || ghRoute === 'gh') && (
              <div className="macos-section">
                <span className="macos-section-header">{t('memsync.stepRepo', { n: step++ })}</span>
                <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
                  {st.rootReady ? (
                    <p className="macos-row-sub" style={{ marginTop: 0 }}>
                      {t('memsync.cloneReady', { repo: c.repoFull || st.clone.origin || '', path: c.clonePath })}
                    </p>
                  ) : (
                    <>
                      <label className="macos-row-sub" htmlFor="memsync-repo" style={{ display: 'block', marginBottom: 6 }}>
                        {t('memsync.repoNameLabel', { login: st.gh.login || '<you>' })}
                      </label>
                      <input id="memsync-repo" className="macos-input" value={repoName} onChange={(e) => setRepoName(e.target.value)} disabled={acting} spellCheck={false} />
                      <p className="remote-note">{t('memsync.clonePathNote', { path: c.clonePath })}</p>
                    </>
                  )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {!st.rootReady && (
                      <button type="button" className="macos-btn-primary" disabled={acting || !st.gh.loggedIn} onClick={() => void setupRepo()}>
                        {busy === 'repo' ? t('memsync.working') : t('memsync.setupRepo')}
                      </button>
                    )}
                    {st.rootReady && (
                      <button type="button" className="macos-btn-secondary" onClick={() => void window.api.memsync.openClone()}>
                        <IconFolder size={12} /> {t('memsync.openClone')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
              )}
            </>
          )}

          {/* 雲端硬碟：選資料夾 */}
          {isFolder && (
            <div className="macos-section">
              <span className="macos-section-header">{t('memsync.stepFolder', { n: step++, provider: providerName(backend) })}</span>
              <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
                {st.cloudRoots[backend].length === 0 ? (
                  <>
                    <p className="macos-row-sub" style={{ marginTop: 0 }}>
                      {st.cloudApps[backend].installed
                        ? t('memsync.cloudNotSignedIn', { provider: providerName(backend) })
                        : t('memsync.cloudNotInstalled', { provider: providerName(backend) })}
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {!st.cloudApps[backend].installed && (
                        <button
                          type="button"
                          className="macos-btn-secondary"
                          onClick={() => pasteInNewShell(backend === 'onedrive' ? st.commands.installOneDrive : st.commands.installGDrive, st.commands.shell)}
                        >
                          {t('memsync.installCloud', { provider: providerName(backend) })}
                        </button>
                      )}
                      {st.cloudApps[backend].installed && st.cloudApps[backend].exe && (
                        <button type="button" className="macos-btn-secondary" disabled={acting} onClick={() => void act('launch', () => window.api.memsync.launchCloudApp(backend))}>
                          {t('memsync.launchCloud', { provider: providerName(backend) })}
                        </button>
                      )}
                      <button type="button" className="macos-btn-secondary" disabled={acting} onClick={() => void refresh()}>
                        <IconRefresh size={12} /> {t('memsync.recheck')}
                      </button>
                    </div>
                    <p className="remote-note">
                      {st.cloudApps[backend].installed ? t('memsync.cloudSignInHint', { provider: providerName(backend) }) : t('memsync.cloudPastedHint')}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="macos-row-sub" style={{ marginTop: 0 }}>
                      {st.rootReady && c.folderPath
                        ? t('memsync.folderReady', { path: c.folderPath })
                        : t('memsync.folderPick', { root: st.cloudRoots[backend].join('、') })}
                    </p>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className={st.rootReady ? 'macos-btn-secondary' : 'macos-btn-primary'}
                        disabled={acting}
                        onClick={() => void act('folder', () => window.api.memsync.pickFolder(), (d) => (d.picked ? t('memsync.folderSet') : null))}
                      >
                        <IconFolder size={12} /> {st.rootReady ? t('memsync.folderChange') : t('memsync.folderChoose')}
                      </button>
                      {st.rootReady && (
                        <button type="button" className="macos-btn-secondary" onClick={() => void window.api.memsync.openClone()}>
                          {t('memsync.openClone')}
                        </button>
                      )}
                    </div>
                    <p className="remote-note">{t('memsync.folderOnly')}</p>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 這個專案 */}
          {backend && (
            <div className="macos-section">
              <span className="macos-section-header">{t('memsync.stepProject', { n: step++ })}</span>
              <div className="macos-inset-group" style={{ padding: '12px 16px' }}>
                {!st.rootReady ? (
                  <p className="macos-row-sub" style={{ margin: 0 }}>{t('memsync.needStorageFirst')}</p>
                ) : !p ? (
                  <p className="macos-row-sub" style={{ margin: 0 }}>{t('memsync.notGitRepo')}</p>
                ) : (
                  <>
                    <p className="macos-row-sub" style={{ marginTop: 0 }}>
                      {t('memsync.projectKey', { key: p.key })}{' '}
                      {p.linked
                        ? t('memsync.projectLinked')
                        : p.linkedElsewhere
                          ? p.linkedToOldStore
                            ? t('memsync.projectLinkedOldStore', { path: p.linkedTo || '' })
                            : t('memsync.projectLinkedElsewhere')
                          : p.hasRemoteMemory
                            ? t('memsync.projectRemoteOnly')
                            : p.hasLocalMemory
                              ? t('memsync.projectLocalOnly')
                              : t('memsync.projectNoMemory')}
                    </p>
                    {p.linked && p.tracked.length > 0 && <p className="remote-note danger">⚠️ {t('memsync.stillTracked', { n: p.tracked.length })}</p>}
                    {p.trackedEntries.length > 0 && <p className="macos-row-sub">{t('memsync.trackedEntries', { files: p.trackedEntries.join(', ') })}</p>}
                    {!p.linked && !p.linkedElsewhere && p.memoryDiffers ? (
                      <>
                        <p className="remote-note danger">⚠️ {t('memsync.memoryDiffers')}</p>
                        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                          <button type="button" className="macos-btn-primary" disabled={acting} onClick={() => void link('shared')}>
                            {busy === 'link' ? t('memsync.working') : t('memsync.useShared')}
                          </button>
                          <button type="button" className="macos-btn-secondary" disabled={acting} onClick={() => void link('local')}>
                            {t('memsync.useLocal')}
                          </button>
                        </div>
                      </>
                    ) : (p.linkedToOldStore || (!p.linkedElsewhere && (p.hasLocalMemory || p.hasRemoteMemory || (p.linked && p.tracked.length > 0)))) && (
                      <button type="button" className="macos-btn-primary" disabled={acting} onClick={() => void link()}>
                        {busy === 'link'
                          ? t('memsync.working')
                          : p.linkedToOldStore
                            ? t('memsync.migrateNow')
                            : p.linked
                            ? t('memsync.untrackNow')
                            : p.hasRemoteMemory
                              ? t('memsync.linkFromStore')
                              : t('memsync.moveToStore')}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* 自動同步 */}
          {st.rootReady && (
            <div className="macos-section">
              <span className="macos-section-header">{t('memsync.stepAuto', { n: step++ })}</span>
              <div className="macos-inset-group">
                {toggleRow(t('memsync.autoLink'), t('memsync.autoLinkSub'), c.autoLink, (v) => void act('config', () => window.api.memsync.setConfig({ autoLink: v })))}
                {backend === 'github' &&
                  toggleRow(t('memsync.autoSync'), t('memsync.autoSyncSub'), c.autoSync, (v) => void act('config', () => window.api.memsync.setConfig({ autoSync: v })))}
              </div>
              {backend === 'github' ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
                  <button type="button" className="macos-btn-primary" disabled={acting} onClick={() => void syncNow()}>
                    {busy === 'sync' ? t('memsync.working') : t('memsync.syncNow')}
                  </button>
                  <span className="macos-row-sub">
                    {t('memsync.cloneCounts', { ahead: st.clone.ahead ?? 0, behind: st.clone.behind ?? 0 })}
                    {st.clone.dirty ? ` · ${t('memsync.cloneDirty')}` : ''}
                  </span>
                </div>
              ) : (
                isFolder && <p className="remote-note">{t('memsync.folderSyncNote', { provider: providerName(backend) })}</p>
              )}
              <p className="remote-note">{t('memsync.handoffNote')}</p>
            </div>
          )}
        </>
      )}

      {message && (
        <p className={`remote-note ${message.kind === 'error' ? 'danger' : ''}`}>
          {message.kind === 'error' ? '⚠️ ' : '✓ '}
          {message.text}
        </p>
      )}
    </div>
  )
}
