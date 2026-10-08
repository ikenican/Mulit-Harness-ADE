import { ipcMain, Notification, BrowserWindow } from 'electron'

// OS 原生通知：長任務結束、或某個 CLI 終端需要審批時提醒使用者。
export function registerNotifyHandlers(): void {
  ipcMain.on('notify:show', (_event, title: string, body: string) => {
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, silent: false })
    // 點通知把視窗帶到前景，使用者才找得到那個待審批的終端
    n.on('click', () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) return
      if (win.isMinimized()) win.restore()
      win.focus()
    })
    n.show()
  })
}
