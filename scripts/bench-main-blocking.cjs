// Measures how long main-process IPC handlers block the event loop.
// Run with: node_modules/.bin/electron scripts/bench-main-blocking.cjs [scan|cli] [--json out.json]
//   scan: dashboard:data / dashboard:usage against a generated fake home (~/.claude, ~/.codex, ~/.gemini logs)
//   cli:  ext:agents / cowork:capabilities against the real home (CLI detection, --help probes)
// A hidden renderer pings main over real IPC while each handler runs; the worst round trip is how long
// the UI would have been frozen. The handlers are bundled from src/ with esbuild, so the same script
// measures the code before and after a change.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { monitorEventLoopDelay } = require('node:perf_hooks')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
// WB_BENCH_SRC=<another checkout> bundles that checkout's src/ (e.g. a worktree of the commit before a change),
// so before/after can run back to back on the same fixture
const SRC = path.resolve(process.env.WB_BENCH_SRC || ROOT)
const mode = process.argv.includes('cli') ? 'cli' : 'scan'
const jsonIdx = process.argv.indexOf('--json')
const jsonOut = jsonIdx > 0 ? process.argv[jsonIdx + 1] : null
const BENCH = path.join(os.tmpdir(), 'wb-bench')
const FAKE_HOME = path.join(BENCH, 'home')

// ── fixture: deterministic fake CLI logs ──────────────────────────────
function makeFixture() {
  const marker = path.join(FAKE_HOME, '.fixture-v1')
  if (fs.existsSync(marker)) return
  fs.rmSync(FAKE_HOME, { recursive: true, force: true })
  const day = (i) => new Date(Date.UTC(2026, 9, 1 + (i % 23), 10, 0, 0)).toISOString()
  const pad = 'x'.repeat(300)
  // Claude: 30 projects x 10 sessions, ~150 KB each
  for (let p = 0; p < 30; p++) {
    const dir = path.join(FAKE_HOME, '.claude', 'projects', `D--bench-project-${p}`)
    fs.mkdirSync(dir, { recursive: true })
    for (let s = 0; s < 10; s++) {
      const rows = []
      for (let i = 0; i < 300; i++) {
        rows.push(JSON.stringify({ type: 'user', cwd: `D:\\bench\\project-${p}`, timestamp: day(i), message: { role: 'user', content: `question ${i} ${pad}` } }))
        rows.push(JSON.stringify({ type: 'assistant', cwd: `D:\\bench\\project-${p}`, timestamp: day(i), message: { id: `m${p}-${s}-${i}`, model: 'claude-opus', usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 }, content: [{ type: 'text', text: pad }] } }))
      }
      fs.writeFileSync(path.join(dir, `00000000-0000-0000-0000-${String(p * 100 + s).padStart(12, '0')}.jsonl`), rows.join('\n'))
    }
  }
  // Codex: 200 rollouts, ~150 KB each
  for (let s = 0; s < 200; s++) {
    const dir = path.join(FAKE_HOME, '.codex', 'sessions', '2026', '10', String(1 + (s % 23)).padStart(2, '0'))
    fs.mkdirSync(dir, { recursive: true })
    const id = `0199aaaa-bbbb-cccc-dddd-${String(s).padStart(12, '0')}`
    const rows = [JSON.stringify({ timestamp: day(s), type: 'session_meta', payload: { id, cwd: `D:\\bench\\project-${s % 30}` } })]
    for (let i = 1; i <= 300; i++) {
      rows.push(JSON.stringify({ timestamp: day(s), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: i * 100, cached_input_tokens: i * 40, output_tokens: i * 10 } } } }))
      rows.push(JSON.stringify({ timestamp: day(s), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: pad }] } }))
    }
    fs.writeFileSync(path.join(dir, `rollout-2026-10-01T10-00-00-${id}.jsonl`), rows.join('\n'))
  }
  // Antigravity: 50 brain transcripts, ~100 KB each
  for (let s = 0; s < 50; s++) {
    const dir = path.join(FAKE_HOME, '.gemini', 'antigravity-cli', 'brain', `agy-${s}`, '.system_generated', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const rows = []
    for (let i = 0; i < 150; i++) {
      rows.push(JSON.stringify({ type: 'USER_INPUT', source: 'USER', created_at: day(i), content: `<USER_REQUEST>task ${s}</USER_REQUEST> ${pad}` }))
      rows.push(JSON.stringify({ type: 'PLANNER_RESPONSE', source: 'MODEL', created_at: day(i), thinking: pad, content: pad }))
    }
    fs.writeFileSync(path.join(dir, 'transcript.jsonl'), rows.join('\n'))
  }
  fs.writeFileSync(marker, '')
}

// ── bundle the real handlers; only the window-management module is stubbed ──
async function bundle() {
  // inside the repo so externals (node-pty, …) resolve from node_modules
  const outDir = path.join(ROOT, 'node_modules', '.cache', 'wb-bench')
  const out = path.join(outDir, `handlers-${process.pid}.cjs`)
  const indexTs = path.join(SRC, 'src', 'main', 'index.ts')
  const stubIndex = {
    name: 'stub-main-index',
    setup(b) {
      b.onResolve({ filter: /^\.\.?\/(\.\.\/)*index$/ }, (a) => {
        const p = path.resolve(a.resolveDir, a.path) + '.ts'
        return p === indexTs ? { path: p, namespace: 'stub' } : undefined
      })
      b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        loader: 'js',
        contents: `
          const ws = ${JSON.stringify(ROOT)}
          exports.workspace = { root: ws }
          exports.getWorkspaceForEvent = () => ws
          exports.getAllProjectWindows = () => []
          exports.setWorkspaceForWindow = () => {}
          exports.openProjectWindow = () => null`
      }))
      // electron-vite worker imports: build the worker file and hand back a factory
      b.onResolve({ filter: /\?nodeWorker$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.replace(/\?nodeWorker$/, '')) + '.ts', namespace: 'node-worker' }))
      b.onLoad({ filter: /.*/, namespace: 'node-worker' }, (a) => {
        const workerOut = path.join(outDir, `worker-${path.basename(a.path, '.ts')}-${process.pid}.cjs`)
        esbuild.buildSync({ entryPoints: [a.path], bundle: true, platform: 'node', format: 'cjs', outfile: workerOut, external: ['electron'], logLevel: 'error' })
        return { loader: 'js', contents: `const { Worker } = require('node:worker_threads'); module.exports = (o) => new Worker(${JSON.stringify(workerOut)}, o)` }
      })
    }
  }
  await esbuild.build({
    stdin: {
      contents: `
        export { registerDashboardHandlers } from './src/main/ipc/dashboard'
        export { registerExtHandlers } from './src/main/ipc/ext'
        export { registerCoworkHandlers } from './src/main/ipc/cowork'`,
      resolveDir: SRC,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    external: ['electron', '@lydell/node-pty', 'electron-updater', 'node-forge'],
    nodePaths: [path.join(ROOT, 'node_modules')],
    plugins: [stubIndex],
    logLevel: 'error'
  })
  return out
}

const renderer = `
const { ipcRenderer } = require('electron')
window.runOp = async (channel, args) => {
  const rtts = []
  let done = false
  const pinger = (async () => {
    while (!done) {
      const t = performance.now()
      await ipcRenderer.invoke('bench:ping')
      rtts.push(performance.now() - t)
      await new Promise((r) => setTimeout(r, 5))
    }
  })()
  await new Promise((r) => setTimeout(r, 30))
  const t0 = performance.now()
  const res = await ipcRenderer.invoke(channel, ...args)
  const wall = performance.now() - t0
  await new Promise((r) => setTimeout(r, 30))
  done = true
  await pinger
  rtts.sort((a, b) => a - b)
  const q = (p) => rtts[Math.min(rtts.length - 1, Math.floor(rtts.length * p))] || 0
  const size = JSON.stringify(res ?? null).length
  return { wall, pings: rtts.length, p50: q(0.5), p95: q(0.95), max: rtts[rtts.length - 1] || 0, size, res }
}
0`

app.on('window-all-closed', () => {})
app.whenReady().then(async () => {
  if (mode === 'scan') {
    makeFixture()
    // --touch: every fake session was written "just now" (status active, all listed); without it the
    // fixture ages and sessions turn idle/completed, so compare before/after runs made with the same flag
    if (process.argv.includes('--touch')) {
      const now = new Date()
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name)
          if (e.isDirectory()) walk(p)
          fs.utimesSync(p, now, now)
        }
      }
      walk(FAKE_HOME)
    }
    process.env.USERPROFILE = FAKE_HOME
    process.env.HOME = FAKE_HOME
  }
  const userData = path.join(BENCH, `userData-${mode}-${process.pid}`)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)

  const tBundle = Date.now()
  const handlersFile = await bundle()
  const h = require(handlersFile)
  ipcMain.handle('bench:ping', () => 1)
  if (mode === 'scan') h.registerDashboardHandlers()
  else {
    h.registerExtHandlers()
    h.registerCoworkHandlers()
  }
  const bundleMs = Date.now() - tBundle

  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  await win.webContents.executeJavaScript(renderer)

  const steps = mode === 'scan'
    ? [
        ['dashboard:data (cold cache)', 'dashboard:data', [true]],
        ['dashboard:data (warm)', 'dashboard:data', [false]],
        ['dashboard:data (warm, force)', 'dashboard:data', [true]],
        ['dashboard:usage (warm)', 'dashboard:usage', []]
      ]
    : [
        ['ext:agents (1st)', 'ext:agents', []],
        ['ext:agents (2nd)', 'ext:agents', []],
        ['cowork:capabilities force (1st, --help probes)', 'cowork:capabilities', [true]],
        ['cowork:capabilities force (2nd, probes cached)', 'cowork:capabilities', [true]]
      ]

  const h2 = monitorEventLoopDelay({ resolution: 5 })
  const results = []
  for (const [label, channel, args] of steps) {
    h2.reset()
    h2.enable()
    const r = await win.webContents.executeJavaScript(`window.runOp(${JSON.stringify(channel)}, ${JSON.stringify(args)})`)
    h2.disable()
    results.push({ label, ...r, loopMaxMs: h2.max / 1e6 })
  }
  const fmt = (n) => n.toFixed(1).padStart(8)
  console.log(`\nmode=${mode} bundle=${bundleMs}ms home=${mode === 'scan' ? FAKE_HOME : os.homedir()}`)
  console.log('step'.padEnd(50) + '   wall ms  ipc p50  ipc p95  ipc max  loop max  pings   bytes')
  for (const r of results) {
    console.log(r.label.padEnd(50) + fmt(r.wall) + ' ' + fmt(r.p50) + ' ' + fmt(r.p95) + ' ' + fmt(r.max) + '  ' + fmt(r.loopMaxMs) + '  ' + String(r.pings).padStart(5) + String(r.size).padStart(8))
  }
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ mode, results }, null, 2))
  fs.rmSync(handlersFile, { force: true })
  app.exit(0)
}).catch((e) => {
  console.error(e)
  app.exit(1)
})
