import { useEffect, useState } from 'react'
import { useWorkbench } from '@/store'
import { useTranslation } from '@/i18n'
import { CUSTOM_RESOURCE_KINDS, type CustomAgentConfig, type CustomResourceKind } from '../../../../shared/customAgent'

export default function CustomAgentExtensions(): JSX.Element | null {
  const { settingsTick } = useWorkbench()
  const { t } = useTranslation()
  const [config, setConfig] = useState<CustomAgentConfig>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    window.api.settings.get().then((s) => { if (active) { setConfig(s.customAgent); setError('') } })
      .catch(() => { if (active) setError(t('customAgent.loadError')) })
    return () => { active = false }
  }, [settingsTick])
  if (error) return <div className="cz-error" role="alert">{error}</div>
  return config?.enabled ? <NativeFiles key={JSON.stringify(config)} config={config} /> : null
}

function NativeFiles({ config }: { config: CustomAgentConfig }): JSX.Element {
  const { t } = useTranslation()
  const [kind, setKind] = useState<CustomResourceKind>('skill')
  const [files, setFiles] = useState<string[]>([])
  const [file, setFile] = useState('')
  const [opened, setOpened] = useState<string | null>(null)
  const [before, setBefore] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const dirty = opened !== null && content !== (before ?? '')
  const directory = kind === 'skill' || kind === 'plugin'
  const reset = () => { setOpened(null); setBefore(null); setContent(''); setMessage(''); setError('') }

  useEffect(() => {
    let active = true
    setFiles([])
    setFile('')
    if (!config.resources[kind]) return
    setBusy(true)
    window.api.ext.customList(kind).then((list) => {
      if (active) { setFiles(list); if (!directory) setFile(list[0] || '') }
    }).catch((e) => { if (active) setError(String(e)) })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [config, kind])

  const open = async (target: string) => {
    setBusy(true); setError(''); setMessage('')
    try {
      const text = await window.api.ext.customRead(kind, target)
      setFile(target); setOpened(target); setBefore(text); setContent(text ?? '')
    } catch (e) { setError(String(e)) } finally { setBusy(false) }
  }

  return <section className="cz-section custom-agent-extensions">
    <h3>{t('customAgent.extensions')} · {config.name}</h3>
    <p className="cz-conn-note">{t('customAgent.nativeHint')}</p>
    <div className="cz-toolbar" role="group" aria-label={t('customAgent.extensions')}>
      {CUSTOM_RESOURCE_KINDS.map((k) => <button type="button" key={k} className={`btn ${kind === k ? 'btn-primary' : ''}`}
        aria-pressed={kind === k} disabled={busy || dirty} onClick={() => { reset(); setKind(k) }}>{t(`customAgent.${k}`)}</button>)}
    </div>
    {!config.resources[kind] ? <p className="cz-empty">{t('customAgent.notConfigured')}</p> : <>
      <p className="cz-agent-path">{config.resources[kind]}</p>
      {directory && <div className="cz-toolbar">
        <select className="macos-input" aria-label={t(`customAgent.${kind}`)} value={files.includes(file) ? file : ''}
          disabled={busy || dirty} onChange={(e) => { reset(); setFile(e.target.value) }}>
          <option value="">{t('customAgent.newFile')}</option>
          {files.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <label className="custom-agent-file-label">{t('customAgent.file')}
          <input className="macos-input" value={file} disabled={busy || dirty}
            placeholder={kind === 'skill' ? 'my-skill/SKILL.md' : 'my-plugin/plugin.json'}
            onChange={(e) => setFile(e.target.value)} />
        </label>
      </div>}
      <div className="cz-toolbar">
        <button type="button" className="btn" disabled={busy || dirty || !file.trim()} onClick={() => open(file)}>{t('customAgent.open')}</button>
        {opened !== null && <>
          <button type="button" className="btn" disabled={busy || dirty} onClick={() => open(opened)}>{t('customAgent.reload')}</button>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => {
            setBusy(true); setError(''); setMessage('')
            try {
              await window.api.ext.customWrite(kind, opened, content, before)
              setBefore(content); setMessage(t('customAgent.saved'))
              setFiles(await window.api.ext.customList(kind))
            } catch (e) { setError(String(e)) } finally { setBusy(false) }
          }}>{t('common.save')}</button>
          {dirty && <button type="button" className="btn" disabled={busy} onClick={() => { setContent(before ?? ''); setMessage(''); setError('') }}>{t('customAgent.discard')}</button>}
        </>}
      </div>
      {opened !== null && <>
        <div className="cz-hint">{opened} · {dirty ? t('customAgent.unsaved') : before === null ? t('customAgent.newHint') : ''}</div>
        <textarea className="custom-agent-editor" aria-label={`${t(`customAgent.${kind}`)}: ${opened}`} spellCheck={false}
          value={content} disabled={busy} onChange={(e) => { setContent(e.target.value); setMessage('') }} />
      </>}
    </>}
    {error && <div className="cz-error" role="alert">{error}</div>}
    {message && <div role="status">{message}</div>}
  </section>
}
