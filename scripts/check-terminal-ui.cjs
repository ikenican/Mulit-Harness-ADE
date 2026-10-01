// Run with: node_modules/.bin/electron scripts/check-terminal-ui.cjs
// Uses the installed Electron/Chromium and real xterm, no test framework.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
app.on('window-all-closed', () => {})

const fixture = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { trackComposition, isImeKey } from '/src/renderer/src/panels/terminal/imeGuard.ts'
import TerminalView from '/src/renderer/remote/TerminalView.tsx'
import '/src/renderer/remote/remote.css'
window.makeTerminal = (guarded) => {
  window.term?.dispose()
  document.body.innerHTML = '<div id="desktop" style="width:600px;height:300px"></div>'
  const term = new Terminal()
  term.open(document.getElementById('desktop'))
  window.term = term
  window.sent = []
  term.onData(d => window.sent.push(d))
  if (guarded) trackComposition(term)
  term.attachCustomKeyEventHandler(e => {
    if (guarded && isImeKey(term, e)) return false
    return true
  })
  term.focus()
}
const messages = new Set(), states = new Set()
const open = Terminal.prototype.open
Terminal.prototype.open = function(el) { open.call(this, el); if (el.classList.contains('xterm-box')) window.mobileTerm = this }
window.requests = []
window.deliver = m => messages.forEach(fn => fn(m))
const conn = {
  state: 'open',
  send(m) {
    window.requests.push(m)
    if (m.t === 'resize') setTimeout(() => window.deliver({...m, t:'resized'}), 0)
  },
  onMessage(fn) { messages.add(fn); return () => messages.delete(fn) },
  onState(fn) { states.add(fn); return () => states.delete(fn) }
}
window.mountMobile = () => {
  window.term?.dispose()
  window.term = null
  document.body.innerHTML = '<div id="root"></div>'
  createRoot(document.getElementById('root')).render(<TerminalView conn={conn}
    session={{id:'check', title:'A'.repeat(300), workspaceName:'workspace', cols:160, rows:40}}
    hostName="desktop" onBack={() => {}} />)
}
window.ready = true
`

app.whenReady().then(async () => {
  const { createServer } = await import('vite')
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-terminal-check-'))
  const server = await createServer({ configFile: false, cacheDir,
    plugins: [{ name: 'terminal-check', resolveId(id) { if (id === '/__check.tsx') return id }, load(id) { if (id === '/__check.tsx') return fixture },
      configureServer(s) { s.middlewares.use((req, res, next) => {
        if (req.url === '/__check.html') {
          res.setHeader('Content-Type', 'text/html')
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><script>window.onerror=(m)=>console.error(m)</script><script type="module" src="/__check.tsx"></script>')
        } else next()
      }) }
    }],
    esbuild: { jsx: 'automatic' }, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const win = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true, webPreferences: { backgroundThrottling: false, offscreen: true } })
  const run = code => win.webContents.executeJavaScript(code)
  const pause = () => new Promise(r => setTimeout(r, 400))
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 2) console.log(message) })
  try {
    await win.loadURL(server.resolvedUrls.local[0] + '__check.html')
    for (let i = 0; i < 100 && !await run('window.ready'); i++) await new Promise(r => setTimeout(r, 50))
    assert.equal(await run('window.ready'), true, 'fixture loaded')
    for (const guarded of [false, true]) {
      await run(`window.makeTerminal(${guarded})`)
      const result = await run(`(async () => {
        const ta = term.textarea
        ta.dispatchEvent(new CompositionEvent('compositionstart', {bubbles:true}))
        ta.value = '你好'
        ta.dispatchEvent(new CompositionEvent('compositionupdate', {data:'你好', bubbles:true}))
        await new Promise(r => setTimeout(r, 10))
        ta.dispatchEvent(new KeyboardEvent('keydown', {key:' ', keyCode:32, isComposing:true, bubbles:true, cancelable:true}))
        ta.dispatchEvent(new CompositionEvent('compositionend', {data:'你好', bubbles:true}))
        await new Promise(r => setTimeout(r, 20))
        return sent
      })()`)
      console.log(guarded ? 'guarded IME:' : 'stock IME:', JSON.stringify(result))
      if (guarded) assert.deepEqual(result, ['你好'], 'one IME commit, no command Enter or duplicate')
      else assert.deepEqual(result, ['你好', '你好'], 'reproduce duplicate in stock xterm')
    }
    // Native Chromium composition, including a retained field and repeated commits.
    win.webContents.debugger.attach('1.3')
    await run('window.makeTerminal(true); term.textarea.value = "OLD TEXT "')
    for (const text of ['中文測試', '中文測試', '，', '😀']) {
      await win.webContents.debugger.sendCommand('Input.imeSetComposition', {text, selectionStart:text.length, selectionEnd:text.length})
      await win.webContents.debugger.sendCommand('Input.insertText', {text})
      await pause()
    }
    assert.deepEqual(await run('sent'), ['中文測試', '中文測試', '，', '😀'], 'native compositions exactly once')
    assert.equal(await run('term.textarea.value'), '', 'no retained IME text')
    // IME passthrough punctuation must not diff/re-emit previously typed content.
    assert.deepEqual(await run(`(async () => {
      sent.length = 0
      const ta = term.textarea
      ta.value = 'already sent'
      ta.dispatchEvent(new KeyboardEvent('keydown', {key:'Process', keyCode:229, bubbles:true, cancelable:true}))
      ta.value = 'already sen。'
      ta.dispatchEvent(new InputEvent('input', {data:'。', inputType:'insertText', bubbles:true, composed:true}))
      await new Promise(r => setTimeout(r, 20))
      return sent
    })()`), ['。'], 'only new IME punctuation, never the old field')
    await run('sent.length = 0; term.textarea.dispatchEvent(new KeyboardEvent("keydown", {key:"Enter", keyCode:13, bubbles:true, cancelable:true}))')
    assert.deepEqual(await run('sent'), ['\r'], 'Enter still submits outside composition')
    await run('sent.length = 0; term.paste("paste once")')
    assert.deepEqual(await run('sent'), ['paste once'], 'paste unchanged')
    console.log('native IME / passthrough / Enter / paste: passed')

    await run('window.mountMobile()')
    await pause()
    await run('Array.from(document.querySelectorAll(".segmented button"))[1].click()')
    await pause()
    for (const scale of [1, 2, 3]) {
      for (const width of [320, 390, 768, 320]) {
        win.setContentSize(width, 844)
        await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {width, height:844, deviceScaleFactor:scale, mobile:true})
        await pause()
        const bounds = await run(`(() => {
          const host = document.querySelector('.xterm-box')
          const screen = host.querySelector('.xterm-screen').getBoundingClientRect()
          return {width:innerWidth, page:document.documentElement.scrollWidth,
            box:host.getBoundingClientRect().right, right:screen.right, cols:mobileTerm.cols,
            scroll:document.querySelector('.xterm-scroll').scrollWidth,
            client:document.querySelector('.xterm-scroll').clientWidth}
        })()`)
        assert.equal(bounds.width, width)
        assert.ok(bounds.page <= width, JSON.stringify(bounds))
        assert.ok(bounds.right <= bounds.box - 9, 'all terminal columns inside phone: ' + JSON.stringify(bounds))
        if (bounds.scroll > bounds.client) console.log(await run(`JSON.stringify({dims:mobileTerm._core._renderService.dimensions,paused:mobileTerm._core._renderService._isPaused,visibility:document.visibilityState, elements:Array.from(document.querySelectorAll('.xterm-box *')).slice(0,10).map(el=>({c:el.className,style:el.style.cssText,computed:getComputedStyle(el).width,rect:el.getBoundingClientRect().toJSON()}))})`))
        assert.equal(bounds.scroll, bounds.client, 'no horizontal scroll range: ' + JSON.stringify(bounds))
        console.log(`mobile ${width}px @${scale}x: ${bounds.cols} columns, no overflow`)
      }
    }
    const cols = await run('mobileTerm.cols')
    await run(`window.deliver({t:'snapshot', id:'check', cols:160, rows:40, data:'你好 '+ 'x'.repeat(300)})`)
    await pause()
    assert.equal(await run('mobileTerm.cols'), cols, 'reconnect snapshot refits')
    assert.ok(await run(`Array.from({length:mobileTerm.buffer.active.length}, (_,i)=>mobileTerm.buffer.active.getLine(i).translateToString(true)).join('').includes('x'.repeat(300))`), 'narrowing reflows all output without discarding text')
    await run(`window.deliver({t:'resized', id:'check', cols:160, rows:40})`)
    await pause()
    assert.equal(await run('mobileTerm.cols'), cols, 'desktop resize cannot leave phone wide')
    assert.ok(await run('requests.filter(m => m.t === "resize").length') < 40, 'no resize feedback loop')
    console.log('mobile reconnect / desktop resize: passed')
  } finally {
    win.destroy()
    await server.close()
  }
  app.quit()
}).catch(err => { console.error(err); app.exit(1) })
