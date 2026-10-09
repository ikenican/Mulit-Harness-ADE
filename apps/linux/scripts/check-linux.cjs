const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const yaml = require('js-yaml')

function load(relative, mocks = {}, extra = '') {
  const filename = path.resolve(__dirname, '..', relative)
  const code = ts.transpileModule(fs.readFileSync(filename, 'utf8') + extra, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  const context = vm.createContext({
    module, exports: module.exports, console, Buffer, URL, AbortSignal,
    setTimeout, clearTimeout, setInterval, clearInterval,
    process: { ...process, platform: 'linux', env: { SHELL: '/bin/zsh' } },
    require: id => Object.hasOwn(mocks, id) ? mocks[id] : require(id)
  })
  new vm.Script(code, { filename }).runInContext(context)
  return { exports: module.exports, context }
}

async function main() {
  const app = { isPackaged: false, on() {}, getPath: key => key === 'exe' ? '/opt/agent-workbench-linux/app' : '/home/test/.config/agent-workbench-linux' }
  const aliases = new Map([['/home/test/system-link', '/etc'], ['/home/test/project-link', '/home/test/Project']])
  const settings = load('src/main/ipc/settings.ts', {
    electron: { app, ipcMain: { handle() {} }, BrowserWindow: {} },
    fs: { ...fs, existsSync: p => aliases.has(p), realpathSync: p => aliases.get(p) },
    path: path.posix,
    '../index': { workspace: { root: '/home/test/Project' } },
    '../ext/paths': { findCli: () => null }, '../../shared/cowork': {}
  }).exports
  for (const p of ['', '/', '/home', '/usr', '/usr/local/src', '/etc/passwd', '/proc/self', '/home/test/system-link']) {
    assert.equal(settings.isProtectedPath(p), true, `Must protect ${p}`)
  }
  for (const p of ['/home/test/Project', '/tmp/project', '/usr-project', '/home/test/USR', '/home/test/project-link']) {
    assert.equal(settings.isProtectedPath(p), false, `Must permit ${p}`)
  }
  assert.equal(settings.getWorkspaceSettingsPath(), '/home/test/Project/.workbench-linux/settings.json')
  assert.equal(settings.getGlobalSettingsPath(), '/home/test/.config/agent-workbench-linux/settings.json')

  let custom = null
  const pty = load('src/main/ipc/pty.ts', {
    electron: { app, ipcMain: { handle() {} } },
    '@lydell/node-pty': {},
    '../index': {},
    './settings': { getCustomCliPath: () => custom },
    '../ext/paths': { findAgentCli: () => null },
    './conn': {},
    '../../shared/approvalDetect': {},
    '../../shared/portDetect': {}
  }, '\nexport { resolveCommand }')
  assert.equal(pty.exports.resolveCommand('shell').cmd, '/bin/zsh')
  pty.context.process.env.SHELL = '/usr/bin/fish'
  assert.equal(pty.exports.resolveCommand('shell').cmd, '/usr/bin/fish')
  delete pty.context.process.env.SHELL
  assert.equal(pty.exports.resolveCommand('shell').cmd, '/bin/bash')
  assert.equal(pty.exports.resolveCommand('bash').cmd, 'bash')
  custom = '/home/test/bin/my-shell'
  assert.equal(pty.exports.resolveCommand('shell').cmd, custom)

  const fileHandlers = new Map()
  load('src/main/ipc/files.ts', {
    electron: { ipcMain: { handle: (name, fn) => fileHandlers.set(name, fn) }, BrowserWindow: {}, shell: {}, dialog: {} },
    path: path.posix,
    '../index': { workspace: { root: '/home/test/Project' }, getWorkspaceForEvent: () => '/home/test/Project' },
    './settings': {}, './dashboard': {}
  }, '\nregisterFileHandlers()')
  await assert.rejects(() => fileHandlers.get('files:read')(null, '/home/test/project/private.txt'), /Access denied/)
  await assert.rejects(() => fileHandlers.get('files:read')(null, '../private.txt'), /Access denied/)

  const update = load('src/main/ipc/updater.ts', { electron: {}, './settings': {} }).exports
  const release = (tag, extra = {}) => ({
    tag_name: tag, prerelease: true, draft: false,
    assets: [{ name: 'Agent-Workbench-Linux-0.2.0-x64.AppImage' }], ...extra
  })
  const selected = update.selectLinuxRelease([
    release('v9.0.0', { prerelease: false }), release('linux-v0.2.0'),
    release('linux-v0.10.0'), release('linux-v0.20.0', { draft: true }),
    release('linux-v0.30.0', { assets: [] }), release('linux-v0.40.0', { prerelease: false }),
    release('linux-v0.50.0', { assets: [{ name: 'Agent-Workbench-setup.exe' }] }),
    release('linux-vbad'), null
  ], '0.1.0')
  assert.equal(selected.version, '0.10.0')
  assert.match(selected.downloadUrl, /\/tag\/linux-v0\.10\.0$/)
  assert.equal(update.selectLinuxRelease([release('linux-v0.1.0')], '0.1.0'), undefined)
  assert.throws(() => update.selectLinuxRelease({}, '0.1.0'), /Invalid/)

  const credentialHandlers = new Map()
  let backend = 'basic_text', encrypted = false
  load('src/main/ipc/conn.ts', {
    electron: {
      ipcMain: { handle: (name, fn) => credentialHandlers.set(name, fn) },
      safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
        encryptString() { encrypted = true; throw new Error('encryption reached') } }
    },
    '../index': { workspace: { root: '/unused' } }, '../ext/manifest': {}
  }, '\nregisterConnHandlers()')
  await assert.rejects(() => credentialHandlers.get('conn:set')(null, 'example', 'test-value'), /refusing/)
  assert.equal(encrypted, false)
  backend = 'gnome_libsecret'
  await assert.rejects(() => credentialHandlers.get('conn:set')(null, 'example', 'test-value'), /encryption reached/)
  assert.equal(encrypted, true)

  const packageJson = require('../package.json')
  const builder = yaml.load(fs.readFileSync(path.join(__dirname, '../electron-builder.yml'), 'utf8'))
  assert.equal(packageJson.name, 'agent-workbench-linux')
  assert.equal(builder.appId, 'io.github.zkylek1212-k.agent-workbench-linux')
  assert.equal(builder.win, undefined)
  assert.equal(builder.publish, null)
  assert.deepEqual(builder.linux.target.map(t => t.target), ['AppImage', 'deb', 'tar.gz'])
  assert.ok(builder.deb.depends.includes('libasound2t64 | libasound2'))
  assert.match(packageJson.scripts.dist, /--linux.*--publish never/)
  console.log('Linux paths, default shells, release isolation and credential guards passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
