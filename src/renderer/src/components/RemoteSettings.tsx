import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from '@/i18n'
import { IconPhone, IconShield, IconRefresh } from './Icons'
import type { RemoteDeviceInfo, RemotePairingInfo, RemoteStatus } from '../../../preload/index'

// 設定 → 遠端控制：開關區網 Remote Bridge、顯示 iPhone 設定 QR code、配對碼與已配對裝置。
// 這一頁的變更立即生效（不經過底部的「儲存」按鈕），因為它控制的是正在跑的伺服器。

export default function RemoteSettings({ bypassActive }: { bypassActive: boolean }): JSX.Element {
  const { t } = useTranslation()
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [devices, setDevices] = useState<RemoteDeviceInfo[]>([])
  const [setupQr, setSetupQr] = useState<string | null>(null)
  const [pairing, setPairing] = useState<RemotePairingInfo | null>(null)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)

  const refreshDevices = useCallback(() => {
    window.api.remote.devices().then(setDevices).catch(() => {})
  }, [])

  useEffect(() => {
    window.api.remote.status().then(setStatus).catch(() => {})
    refreshDevices()
    return window.api.remote.onStatusChange((s) => {
      setStatus(s)
      refreshDevices()
    })
  }, [refreshDevices])

  useEffect(() => {
    if (status?.running && status.setupUrl) {
      window.api.remote.qr(status.setupUrl).then(setSetupQr).catch(() => setSetupQr(null))
    } else {
      setSetupQr(null)
      setPairing(null)
    }
  }, [status?.running, status?.setupUrl])

  // 配對碼倒數
  useEffect(() => {
    if (!pairing) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [pairing])

  // 配對成功後 main 會發 status 更新；裝置數變多就把配對碼收起來
  useEffect(() => {
    if (pairing && devices.some((d) => d.createdAt > pairing.expiresAt - 5 * 60 * 1000)) setPairing(null)
  }, [devices, pairing])

  const toggle = async (enabled: boolean): Promise<void> => {
    setBusy(true)
    try {
      setStatus(await window.api.remote.setEnabled(enabled))
    } finally {
      setBusy(false)
    }
  }

  const newCode = async (): Promise<void> => {
    setPairing(await window.api.remote.createPairing())
    setNow(Date.now())
  }

  const revoke = async (id: string): Promise<void> => {
    await window.api.remote.revokeDevice(id)
    refreshDevices()
  }

  const resetTrust = async (): Promise<void> => {
    if (!window.confirm(t('remote.resetConfirm'))) return
    setBusy(true)
    try {
      setStatus(await window.api.remote.resetTrust())
      setPairing(null)
      refreshDevices()
    } finally {
      setBusy(false)
    }
  }

  const secondsLeft = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
  const fmtTime = (ms: number): string => new Date(ms).toLocaleString()

  return (
    <div className="macos-settings-body">
      <div className="macos-section">
        <div className="macos-inset-group">
          <div className="macos-row">
            <div className="macos-row-main">
              <div className="macos-row-left">
                <div className="macos-row-badge-icon" style={{ background: status?.running ? '#16A34A' : '#64748B' }}>
                  <IconPhone size={14} />
                </div>
                <div className="macos-row-info">
                  <div className="macos-row-title-row">
                    <span className="macos-row-title">{t('remote.enable')}</span>
                    <span className="macos-type-pill">{status?.running ? t('remote.running') : t('remote.stopped')}</span>
                  </div>
                  <span className="macos-row-sub">{t('remote.enableSub')}</span>
                </div>
              </div>
              <div className="macos-row-right">
                <label className="apple-toggle">
                  <input
                    type="checkbox"
                    disabled={busy || !status}
                    checked={!!status?.enabled}
                    onChange={(e) => void toggle(e.target.checked)}
                  />
                  <span className="apple-toggle-slider" />
                </label>
              </div>
            </div>
          </div>
        </div>
        {status?.enabled && (
          <div className="remote-notes">
            <p className="remote-note warn">
              <IconShield size={12} /> {t('remote.warning')}
            </p>
            {bypassActive && <p className="remote-note danger">⚠️ {t('remote.bypassWarning')}</p>}
            {status.error && <p className="remote-note danger">⚠️ {status.error}</p>}
            {status.running && status.addresses.length === 0 && <p className="remote-note danger">{t('remote.noLan')}</p>}
          </div>
        )}
      </div>

      {status?.running && status.setupUrl && (
        <div className="macos-section">
          <span className="macos-section-header">{t('remote.step1')}</span>
          <div className="macos-inset-group remote-card">
            {setupQr && <img className="remote-qr" src={setupQr} alt="setup QR code" />}
            <div className="remote-card-text">
              <p className="macos-row-sub">{t('remote.step1Sub')}</p>
              <code className="remote-url">{status.setupUrl}</code>
              {status.caFingerprint && (
                <p className="remote-fp">
                  {t('remote.fingerprint')}
                  <br />
                  <code>{status.caFingerprint}</code>
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {status?.running && status.appUrl && (
        <div className="macos-section">
          <span className="macos-section-header">{t('remote.step2')}</span>
          <div className="macos-inset-group remote-card">
            {pairing?.pairQr && secondsLeft > 0 && <img className="remote-qr" src={pairing.pairQr} alt="pairing QR code" />}
            <div className="remote-card-text">
              <p className="macos-row-sub">{t('remote.step2Sub')}</p>
              <code className="remote-url">{status.appUrl}</code>
              {pairing && secondsLeft > 0 ? (
                <>
                  <div className="remote-code">
                    {pairing.code.slice(0, 4)}-{pairing.code.slice(4)}
                  </div>
                  <p className="macos-row-sub">{t('remote.expiresIn', { s: secondsLeft })}</p>
                </>
              ) : (
                <>
                  {pairing && <p className="macos-row-sub">{t('remote.expired')}</p>}
                  <button type="button" className="macos-btn-secondary" onClick={() => void newCode()}>
                    {t('remote.newCode')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="macos-section">
        <span className="macos-section-header">{t('remote.devices')}</span>
        <div className="macos-inset-group">
          {devices.length === 0 && (
            <div className="macos-row">
              <span className="macos-row-sub" style={{ padding: '4px 0' }}>
                {t('remote.noDevices')}
              </span>
            </div>
          )}
          {devices.map((d) => (
            <div className="macos-row" key={d.id}>
              <div className="macos-row-main">
                <div className="macos-row-left">
                  <div className="macos-row-badge-icon" style={{ background: d.online ? '#16A34A' : '#94A3B8' }}>
                    <IconPhone size={14} />
                  </div>
                  <div className="macos-row-info">
                    <div className="macos-row-title-row">
                      <span className="macos-row-title">{d.name}</span>
                      {d.online && <span className="macos-type-pill">{t('remote.online')}</span>}
                      {d.pushEnabled && <span className="macos-type-pill">{t('remote.push')}</span>}
                    </div>
                    <span className="macos-row-sub">{t('remote.lastSeen', { time: fmtTime(d.lastSeenAt) })}</span>
                  </div>
                </div>
                <div className="macos-row-right">
                  <button type="button" className="macos-btn-secondary" onClick={() => void revoke(d.id)}>
                    {t('remote.revoke')}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
        {status?.enabled && (
          <button
            type="button"
            className="macos-btn-secondary remote-reset"
            disabled={busy}
            onClick={() => void resetTrust()}
          >
            <IconRefresh size={12} /> {t('remote.resetTrust')}
          </button>
        )}
      </div>
    </div>
  )
}
