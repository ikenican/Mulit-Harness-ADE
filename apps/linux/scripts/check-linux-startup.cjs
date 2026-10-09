const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

assert.equal(process.platform, 'linux')
app.setPath('appData', fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-linux-startup-')))
const deadline = setTimeout(() => { console.error('Linux startup check timed out'); app.exit(1) }, 30000)
let loaded = 0
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-fail-load', (_event, code, description) => {
    console.error('Linux window failed to load', code, description)
    app.exit(1)
  })
  win.webContents.once('did-finish-load', async () => {
    try {
      const rendered = await win.webContents.executeJavaScript(`new Promise(resolve => {
        let tries = 0
        const timer = setInterval(() => {
          if (document.getElementById('root')?.childElementCount && window.api) {
            clearInterval(timer); resolve(true)
          } else if (++tries > 50) { clearInterval(timer); resolve(false) }
        }, 100)
      })`)
      assert.equal(rendered, true, 'React and preload API must initialize')
      assert.match(app.getPath('userData'), /agent-workbench-linux-dev$/)
      const status = await win.webContents.executeJavaScript('window.api.updater.getStatus()')
      assert.equal(status.currentVersion, app.getVersion())
      if (++loaded === 1) {
        const shellId = await win.webContents.executeJavaScript("window.api.pty.spawn({ command: 'shell' })")
        assert.equal(typeof shellId, 'string')
        await win.webContents.executeJavaScript(`window.api.pty.kill(${JSON.stringify(shellId)})`)
        await win.webContents.executeJavaScript('window.api.window.detachTerminal()')
      } else {
        assert.equal(BrowserWindow.getAllWindows().length, 2)
        clearTimeout(deadline)
        console.log('Linux main and detached terminal windows loaded with isolated user data')
        app.exit(0)
      }
    } catch (error) { console.error(error); app.exit(1) }
  })
})
require('../out/main/index.js')
