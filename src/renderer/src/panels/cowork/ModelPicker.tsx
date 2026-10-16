// 一家 agent 的模型＋推理強度選擇。設定頁與開會表單共用。
// 空字串 = 預設；預設實際代表什麼由模型目錄的 fallback 說明（codex 是使用者 config.toml 的值）。
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import {
  agentLabel,
  modelPickerState,
  pickModel,
  type AgentModelChoice,
  type CoworkAgent,
  type CoworkModelCatalog
} from '../../../../shared/cowork'

// 所有元件共用一份：main 端第一次要跑 CLI 讀清單（agy 要連網），不必每個畫面各讀一次
let catalogs: Promise<CoworkModelCatalog[]> | null = null

export function loadModelCatalogs(force = false): Promise<CoworkModelCatalog[]> {
  if (!catalogs || force) {
    catalogs = window.api.cowork.models(force).then((r) => (r.ok ? r.data : []))
  }
  return catalogs
}

export function useModelCatalogs(): { catalogs: CoworkModelCatalog[] | null; refresh: () => void } {
  const [list, setList] = useState<CoworkModelCatalog[] | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    loadModelCatalogs(tick > 0).then((c) => alive && setList(c))
    return () => {
      alive = false
    }
  }, [tick])
  return { catalogs: list, refresh: () => setTick((n) => n + 1) }
}

/** 「預設」那一項的說明文字 */
export function fallbackLabel(t: (k: string, p?: Record<string, string | number>) => string, cat: CoworkModelCatalog | undefined, agent: CoworkAgent): string {
  const cli = agentLabel(agent)
  if (cat?.fallback.model) {
    const model = cat.options.find((o) => o.id === cat.fallback.model || o.resolvedModel === cat.fallback.model)?.label || cat.fallback.model
    return t('cowork.modelDefaultUser', { cli, model })
  }
  return t('cowork.modelDefaultCli', { cli })
}

/** 會議畫面用的簡短顯示：「opus · high」或「預設」 */
export function choiceLabel(t: (k: string) => string, model?: string, effort?: string): string {
  const parts = [model || t('cowork.modelDefaultShort'), effort].filter(Boolean)
  return parts.join(' · ')
}

export default function ModelPicker({
  agent,
  catalog,
  value,
  onChange,
  automaticLabel,
  className = 'cw-select'
}: {
  agent: CoworkAgent
  catalog: CoworkModelCatalog | undefined
  value: AgentModelChoice
  onChange: (v: AgentModelChoice) => void
  automaticLabel?: string
  className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const { options, efforts, mustPickEffort, fallbackEffort } = modelPickerState(agent, catalog, value, !!automaticLabel)
  const known = !value.model || options.some((o) => o.id === value.model)

  return (
    <div className="cw-model-picker">
      <select
        className={className}
        aria-label={t('cowork.modelLabel')}
        title={options.find((o) => o.id === value.model)?.label || value.model || fallbackLabel(t, catalog, agent)}
        value={value.model}
        onChange={(e) => onChange(pickModel(agent, catalog, value, e.target.value, !!automaticLabel))}
      >
        <option value="">{fallbackLabel(t, catalog, agent)}</option>
        {/* Keep an existing choice visible while catalogs load or a model is removed; no free-text entry. */}
        {!known && <option value={value.model} disabled>{value.model}</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <select
        className={className}
        aria-label={t('cowork.effortLabel')}
        value={efforts.length ? value.effort : ''}
        disabled={efforts.length === 0}
        title={efforts.length === 0 ? t('cowork.effortInModel') : value.effort || automaticLabel || (fallbackEffort ? t('cowork.effortDefaultValue', { effort: fallbackEffort }) : t('cowork.effortDefault'))}
        onChange={(e) => onChange({ model: value.model, effort: e.target.value })}
      >
        {!mustPickEffort && (
        <option value="">
          {efforts.length === 0
            ? t('cowork.effortInModel')
            : automaticLabel || (fallbackEffort
              ? t('cowork.effortDefaultValue', { effort: fallbackEffort })
              : t('cowork.effortDefault'))}
        </option>
        )}
        {efforts.map((e) => (
          <option key={e} value={e}>
            {e}
          </option>
        ))}
      </select>
    </div>
  )
}
