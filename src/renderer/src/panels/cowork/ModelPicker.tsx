// 一家 agent 的模型＋推理強度選擇。設定頁與開會表單共用。
// 空字串 = 預設；預設實際代表什麼由模型目錄的 fallback 說明（codex 是使用者 config.toml 的值）。
import { useEffect, useState } from 'react'
import { useTranslation } from '@/i18n'
import {
  COWORK_EFFORTS,
  agentLabel,
  sanitizeModelChoice,
  type AgentModelChoice,
  type CoworkAgent,
  type CoworkModelCatalog
} from '../../../../shared/cowork'

const CUSTOM = '__custom__'

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
  if (cat?.fallback.source === 'user-config' && cat.fallback.model) {
    return t('cowork.modelDefaultUser', { cli, model: cat.fallback.model })
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
  className = 'cw-select'
}: {
  agent: CoworkAgent
  catalog: CoworkModelCatalog | undefined
  value: AgentModelChoice
  onChange: (v: AgentModelChoice) => void
  className?: string
}): JSX.Element {
  const { t } = useTranslation()
  const options = catalog?.options || []
  const known = !value.model || options.some((o) => o.id === value.model)
  const [custom, setCustom] = useState(!known)
  useEffect(() => {
    if (!known) setCustom(true)
  }, [known])

  // 強度選項：codex 依所選（或預設）模型而定；其他家用固定清單
  const modelForEfforts = value.model || catalog?.fallback.model || ''
  const opt = options.find((o) => o.id === modelForEfforts)
  // 清單有給就照清單（空陣列 = 這個模型不支援強度）；agy 自訂的完整 ID 已含強度，不再給選項
  const efforts = opt?.efforts ?? (agent === 'antigravity' && value.model ? [] : COWORK_EFFORTS[agent])
  // agy 選了有強度變體的模型時沒有「預設」可選（見上方 onChange）
  const mustPickEffort = agent === 'antigravity' && !!value.model && !!opt?.efforts?.length
  // 不合法的名稱後端會清成預設：先在這裡標出來，不要默默換掉
  const invalid = !!value.model && sanitizeModelChoice({ model: value.model, effort: '' }).model !== value.model
  const fallbackEffort = catalog?.fallback.effort || options.find((o) => o.id === modelForEfforts)?.defaultEffort || ''

  return (
    <div className="cw-model-picker">
      <select
        className={className}
        aria-label={t('cowork.modelLabel')}
        value={custom ? CUSTOM : value.model}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustom(true)
            return
          }
          setCustom(false)
          // 換模型時，原本的強度若新模型不支援就清掉
          const next = options.find((o) => o.id === e.target.value)
          const keepEffort = !value.effort || !next?.efforts || next.efforts.includes(value.effort)
          let effort = keepEffort ? value.effort : ''
          // agy 的 ID 帶強度：選了有強度變體的模型就一定要有強度，送出去的 <模型>-<強度> 才會是清單裡存在的 ID
          if (agent === 'antigravity' && next?.efforts?.length && !next.efforts.includes(effort)) {
            effort = next.efforts.includes('medium') ? 'medium' : next.efforts[0]
          }
          onChange({ model: e.target.value, effort })
        }}
      >
        <option value="">{fallbackLabel(t, catalog, agent)}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label === o.id ? o.id : `${o.label} (${o.id})`}
          </option>
        ))}
        <option value={CUSTOM}>{t('cowork.modelCustom')}</option>
      </select>
      {custom && (
        <input
          className={`${className} cw-model-custom ${invalid ? 'invalid' : ''}`}
          aria-invalid={invalid}
          title={invalid ? t('cowork.modelInvalid') : undefined}
          value={value.model}
          placeholder={t('cowork.modelCustomPlaceholder')}
          aria-label={t('cowork.modelCustomPlaceholder')}
          onChange={(e) => onChange({ model: e.target.value.trim(), effort: value.effort })}
        />
      )}
      <select
        className={className}
        aria-label={t('cowork.effortLabel')}
        value={efforts.length ? value.effort : ''}
        disabled={efforts.length === 0}
        title={efforts.length === 0 ? t('cowork.effortInModel') : undefined}
        onChange={(e) => onChange({ model: value.model, effort: e.target.value })}
      >
        {!mustPickEffort && (
        <option value="">
          {efforts.length === 0
            ? t('cowork.effortInModel')
            : fallbackEffort
              ? t('cowork.effortDefaultValue', { effort: fallbackEffort })
              : t('cowork.effortDefault')}
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
