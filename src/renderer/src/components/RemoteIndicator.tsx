import { useEffect, useState } from 'react'
import { openSettings } from '@/store'
import { useTranslation } from '@/i18n'
import { IconPhone } from './Icons'

// 標題列的「手機連線中」標示：有人能遠端操作這台電腦時，桌面上一定要看得到。
export default function RemoteIndicator(): JSX.Element | null {
  const { t } = useTranslation()
  const [devices, setDevices] = useState<string[]>([])

  useEffect(() => {
    window.api.remote
      .status()
      .then((s) => setDevices(s.connectedDevices))
      .catch(() => {})
    return window.api.remote.onStatusChange((s) => setDevices(s.connectedDevices))
  }, [])

  if (devices.length === 0) return null
  return (
    <button
      className="btn-icon remote-indicator"
      title={`${t('remote.connectedBadge', { n: devices.length })}: ${devices.join(', ')}`}
      onClick={() => openSettings('remote')}
      style={{ color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 3, width: 'auto', padding: '0 6px' }}
    >
      <IconPhone size={13} />
      <span style={{ fontSize: 11, fontWeight: 600 }}>{devices.length}</span>
    </button>
  )
}
