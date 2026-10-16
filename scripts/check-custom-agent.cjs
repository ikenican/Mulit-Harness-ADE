// node scripts/check-custom-agent.cjs — real settings, extension I/O and PTY dispatch; isolated userData.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-custom-agent-'))
const workspace = { root: path.join(tmp, 'repo') }
const handlers = new Map(), spawned = [], modules = new Map()
const electron = {
  app: Object.assign(new EventEmitter(), { getPath: () => path.join(tmp, 'userData'), isPackaged: false }),
  ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
  BrowserWindow: { getAllWindows: () => [] }
}
function load(file) {
  file = path.resolve(file)
  if (modules.has(file)) return modules.get(file).exports
  const module = { exports: {} }
  modules.set(file, module)
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  new Function('require', 'module', 'exports', code)((id) => {
    if (id === 'electron') return electron
    if (id === '@lydell/node-pty') return { spawn: (...args) => { spawned.push(args); return { pid: 42, onData() {}, onExit() {} } } }
    if (id === '../index') return { workspace, getWorkspaceForEvent: () => workspace.root }
    if (id === './conn') return { resolveConnectionEnv: () => ({}) }
    if (id.startsWith('.')) return load(path.resolve(path.dirname(file), `${id}.ts`))
    return require(id)
  }, module, module.exports)
  return module.exports
}

async function check() {
  fs.mkdirSync(workspace.root, { recursive: true })
  const shared = load('src/shared/customAgent.ts')
  const settings = load('src/main/ipc/settings.ts')
  const resources = load('src/main/ext/customAgent.ts')
  const pty = load('src/main/ipc/pty.ts')
  settings.registerSettingsHandlers()
  const defaults = shared.sanitizeCustomAgent(null)
  assert.equal(defaults.enabled, false)
  assert.deepEqual(pty.listLaunchers(workspace.root), [])
  const config = shared.sanitizeCustomAgent({ enabled: true, name: 'My Harness', command: process.execPath,
    args: ['--example', 'path with spaces', ''], resources: {
      skill: path.join(tmp, 'skills'), plugin: path.join(tmp, 'plugins'),
      mcp: path.join(tmp, 'config', 'mcp.json'), hook: path.join(tmp, 'config', 'hooks.json')
    } })
  assert.deepEqual(config.args, ['--example', 'path with spaces'])
  await assert.rejects(() => handlers.get('settings:set')({}, { customAgent: { ...config, command: '' } }), /executable/)
  await assert.rejects(() => handlers.get('settings:set')({}, { customAgent: { ...config, resources: { ...config.resources, skill: '../outside' } } }), /absolute/)
  await handlers.get('settings:set')({}, { customAgent: config, cliBypassPermissions: true })
  assert.deepEqual(settings.loadSettings().customAgent, config)
  const wsFile = path.join(workspace.root, '.workbench', 'settings.json')
  const wsSettings = JSON.parse(fs.readFileSync(wsFile, 'utf8'))
  assert.equal(wsSettings.customAgent, undefined, 'custom commands are not synced into repositories')
  fs.writeFileSync(wsFile, JSON.stringify({ ...wsSettings, customAgent: { ...config, command: 'malicious', enabled: false } }))
  assert.deepEqual(settings.loadSettings().customAgent, config, 'repository cannot override command, paths or opt-in')

  // A repository launcher cannot impersonate the locally configured harness.
  fs.mkdirSync(path.join(workspace.root, 'agents'))
  fs.writeFileSync(path.join(workspace.root, 'agents', 'spoof.yaml'), 'launcher:\n  id: custom-agent\n  cli: codex\n')
  const launchers = pty.listLaunchers(workspace.root)
  assert.equal(launchers.length, 1)
  assert.equal(launchers[0].id, shared.CUSTOM_AGENT_ID)
  assert.equal(launchers[0].command, process.execPath)
  // Exercise the phone's actual launcher filtering, with the server's network dependencies stubbed.
  const serverModule = { exports: {} }
  const serverCode = transformSync(fs.readFileSync('src/main/remote/server.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code
  new Function('require', 'module', 'exports', serverCode)((id) => {
    if (id === '../ipc/pty') return pty
    if (id === '../ipc/settings') return settings
    if (id === '../../shared/remoteProtocol') return load('src/shared/remoteProtocol.ts')
    return id.startsWith('.') ? {} : require(id)
  }, serverModule, serverModule.exports)
  const bridge = Object.create(serverModule.exports.RemoteBridge.prototype)
  assert.equal(bridge.launchersFor(workspace.root).filter(l => l.key === shared.CUSTOM_AGENT_ID).length, 1)
  assert.equal(bridge.launchersFor('').filter(l => l.key === shared.CUSTOM_AGENT_ID).length, 1, 'global custom harness works without a folder')
  const ctx = { workspace: workspace.root, owner: { id: 1 }, subscribeOwner: false }
  pty.spawnPty({ command: shared.CUSTOM_AGENT_ID, args: ['--extra'] }, ctx)
  pty.spawnPty({ launcherId: shared.CUSTOM_AGENT_ID }, ctx)
  assert.equal(spawned[0][0], process.execPath)
  assert.deepEqual(spawned[0][1], [...config.args, '--extra'])
  assert.deepEqual(spawned[1][1], config.args)
  assert.equal(spawned[0][2].cwd, workspace.root)
  assert.equal(spawned[0][1].some(a => a.includes('bypass') || a === '--no-alt-screen'), false)
  if (process.platform === 'win32') {
    for (const [ext, interpreter, prefix] of [['.ps1', 'powershell.exe', ['-ExecutionPolicy', 'Bypass', '-File']], ['.cmd', 'cmd.exe', ['/c']]]) {
      const command = path.join(tmp, `codex custom harness${ext}`)
      fs.writeFileSync(command, '')
      await handlers.get('settings:set')({}, { customAgent: { ...config, command } })
      pty.spawnPty({ launcherId: shared.CUSTOM_AGENT_ID }, ctx)
      assert.equal(spawned.at(-1)[0], interpreter)
      assert.deepEqual(spawned.at(-1)[1], [...prefix, command, ...config.args], 'script path and spaced args remain separate; no provider flags')
    }
    await handlers.get('settings:set')({}, { customAgent: config })
  }

  for (const kind of shared.CUSTOM_RESOURCE_KINDS) {
    const file = kind === 'skill' ? 'demo/SKILL.md' : kind === 'plugin' ? 'demo/plugin.json' : path.basename(config.resources[kind])
    const first = kind === 'skill' ? '# demo\n' : '{"existing":true}\n'
    assert.equal(resources.readCustomFile(config, kind, file), null)
    resources.writeCustomFile(config, kind, file, first, null)
    assert.equal(resources.readCustomFile(config, kind, file), first)
    assert.ok(resources.listCustomFiles(config, kind).includes(file))
    assert.throws(() => resources.writeCustomFile(config, kind, file, first, null), /changed on disk/)
    const second = kind === 'skill' ? '# changed\n' : '{"existing":true,"new":1}\n'
    resources.writeCustomFile(config, kind, file, second, first)
    const target = kind === 'skill' || kind === 'plugin' ? path.join(config.resources[kind], file) : config.resources[kind]
    assert.equal(fs.readFileSync(`${target}.workbench-backup`, 'utf8'), first)
    assert.equal(resources.listCustomFiles(config, kind).some(f => f.endsWith('.workbench-backup')), false)
    if (kind !== 'skill') {
      assert.throws(() => resources.writeCustomFile(config, kind, file, '{bad', second), SyntaxError)
      assert.equal(fs.readFileSync(target, 'utf8'), second)
    }
    assert.throws(() => resources.readCustomFile({ ...config, enabled: false }, kind, file), /disabled/)
    assert.throws(() => resources.readCustomFile(config, kind, '../escape'), /relative/)
    assert.throws(() => resources.readCustomFile(config, kind, 'demo:escape'), /relative/)
  }
  assert.throws(() => resources.readCustomFile(config, 'mcp', 'other.json'), /configured file/)
  fs.writeFileSync(path.join(config.resources.skill, 'binary'), Buffer.from([0, 1, 2]))
  assert.throws(() => resources.readCustomFile(config, 'skill', 'binary'), /UTF-8/)
  fs.writeFileSync(path.join(config.resources.skill, 'huge'), 'x'.repeat(1024 * 1024 + 1))
  assert.throws(() => resources.readCustomFile(config, 'skill', 'huge'), /1 MB/)
  const outside = path.join(tmp, 'outside')
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(config.resources.skill, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => resources.writeCustomFile(config, 'skill', 'linked/escape.md', 'escape', null), /Symbolic/)
  assert.equal(fs.existsSync(path.join(outside, 'escape.md')), false)
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep')
  assert.throws(() => resources.readCustomFile(config, 'skill', 'demo/SKILL.md.WORKBENCH-BACKUP'), /read-only/)
  const backup = path.join(config.resources.skill, 'demo', 'SKILL.md.workbench-backup')
  fs.unlinkSync(backup)
  fs.linkSync(path.join(outside, 'keep.txt'), backup)
  assert.throws(() => resources.writeCustomFile(config, 'skill', 'demo/SKILL.md', '# new', '# changed\n'), /hard link/)
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'keep')

  await handlers.get('settings:set')({}, { customAgent: { ...config, enabled: false } })
  assert.equal(pty.listLaunchers(workspace.root).length, 0)
  assert.equal(bridge.launchersFor(workspace.root).some(l => l.key === shared.CUSTOM_AGENT_ID), false)
  assert.throws(() => pty.spawnPty({ launcherId: shared.CUSTOM_AGENT_ID }, ctx), /disabled/)
  assert.throws(() => pty.spawnPty({ command: shared.CUSTOM_AGENT_ID }, ctx), /disabled/)
  assert.equal(settings.loadSettings().customAgent.resources.hook, config.resources.hook, 'disabling retains configuration')
  console.log('custom agent: settings isolation, opt-in, PTY args, four resource kinds, backups, conflicts and path boundaries passed')
}
check().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => fs.rmSync(tmp, { recursive: true, force: true }))
