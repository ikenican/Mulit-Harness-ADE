import { useWorkbench, setUsageRange, type UsageRange } from '@/store'
import { useTranslation } from '@/i18n'

const RANGES: UsageRange[] = ['all', '30d', '7d', '1d']

/** Token 用量區間切換（總用量／30d／7d／1d）；Dashboard 與 Vibe 狀態列共用同一個 store 值 */
export default function UsageRangeSwitch({ compact = false }: { compact?: boolean }): JSX.Element {
  const { usageRange } = useWorkbench()
  const { t } = useTranslation()
  return (
    <div className={`segmented usage-range-switch ${compact ? 'compact' : ''}`}>
      {RANGES.map((r) => (
        <button key={r} className={usageRange === r ? 'on' : ''} onClick={() => setUsageRange(r)}>
          {t(`usage.range_${r}`)}
        </button>
      ))}
    </div>
  )
}

export function formatTokens(count: number): string {
  if (count >= 1_000_000_000) return (count / 1_000_000_000).toFixed(2) + 'B'
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(2) + 'M'
  if (count >= 1_000) return (count / 1_000).toFixed(1) + 'k'
  return count.toLocaleString()
}
