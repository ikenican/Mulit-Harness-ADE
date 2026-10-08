// Run with: node scripts/check-approval.cjs (real headless xterm, no CLI processes).
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { transform } = require('esbuild')

async function load(file, overrides = {}) {
  const module = { exports: {} }
  const { code } = await transform(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' })
  new Function('require', 'module', 'exports', code)(id => overrides[id] || require(id), module, module.exports)
  return module.exports
}

async function main() {
  const detection = await load('src/shared/approvalDetect.ts')
  const { looksLikeApprovalPrompt } = detection
  for (const output of [
    'I will approve the changes after the tests pass.',
    'Would you like to see the implementation details?',
    '等待測試確認結果，繼續執行。',
    '1. Yes, the tests pass.\n2. No regressions were found.',
    'A confirmation prompt looks like this:\n```text\nAllow command?\n› 1. Yes\n  2. No\n```',
    'A prompt example is still streaming:\n```text\nOverwrite file? [y/N]',
    'Do you want to proceed?\n❯ 1. Yes\n  2. No\n\n❯ ',
    'Overwrite file? [y/N]\nDone.\n› '
  ]) assert.equal(looksLikeApprovalPrompt(output), false, `ordinary output is not a live prompt: ${output}`)
  assert.equal(looksLikeApprovalPrompt('1. First result\n2. Second result\n\nOverwrite file? [y/N]'), true)
  assert.equal(looksLikeApprovalPrompt('Which login method?\n❯ 1. Email\n  Details.\n\n  2. Company account\n  More details.\n\nEnter to select'), true)

  const processes = []
  const ptys = await load('src/main/ipc/pty.ts', {
    electron: { ipcMain: {}, app: { on() {} } },
    '@lydell/node-pty': { spawn: () => {
      const proc = { pid: 1, write() {}, resize() {}, onData(fn) { this.output = fn }, onExit(fn) { this.exit = fn } }
      processes.push(proc)
      return proc
    } },
    '../index': {}, './conn': { resolveConnectionEnv: () => ({}) },
    './settings': { getCustomCliPath: () => null, isCliBypassPermissions: () => false },
    '../ext/paths': { findAgentCli: () => null },
    '../../shared/approvalDetect': detection,
    '../../shared/portDetect': { detectDevPort: () => null }
  })
  const pause = () => new Promise(resolve => setTimeout(resolve, 250))
  const clear = '\x1b[H\x1b[2J'
  for (const agent of ['claude', 'codex']) {
    const id = ptys.spawnPty({ command: agent, cols: 120, rows: 40 }, { workspace: '', owner: { id: 1 }, subscribeOwner: false })
    const proc = processes.at(-1)
    let alerts = 0
    ptys.ptyEvents.on('approval', promptId => { if (promptId === id) alerts++ })
    proc.output('I will approve the changes after the tests pass.\r\nWorking...')
    await pause()
    assert.equal(ptys.getPtySession(id).needsApproval, false, `${agent}: normal output must not latch approval`)

    const marker = agent === 'claude' ? '❯' : '›'
    // Separate chunks, split ANSI sequences, and a cursor parked above the actual menu.
    proc.output(clear + '\x1b[3;1HDo you want to pro')
    proc.output(`ceed?\x1b[5;2H${marker} 1. Yes\x1b[6;4H2. No\x1b[8;2HEsc to cancel\x1b[1;`)
    proc.output('1H')
    await pause()
    assert.equal(ptys.getPtySession(id).needsApproval, true, `${agent}: rendered prompt across chunks must be recognized`)
    assert.equal(alerts, 1)

    ptys.writePty(id, '\x1b[B')
    assert.equal(ptys.getPtySession(id).needsApproval, true, `${agent}: arrow navigation is not an answered prompt`)
    proc.output(clear + `\x1b[3;1HDo you want to proceed?\x1b[5;4H1. Yes\x1b[6;2H${marker} 2. No\x1b[8;2HEsc to cancel`)
    await pause()
    assert.equal(alerts, 1, `${agent}: navigation and redraw must not notify again`)

    proc.output(clear + 'Continuing automatically...\r\nTests passed.\r\n' + marker + ' ')
    await pause()
    assert.equal(ptys.getPtySession(id).needsApproval, false, `${agent}: disappearing prompt clears without any input`)
    assert.equal(alerts, 1)
    assert.ok(!ptys.getPtyScreenText(id).includes('Do you want to proceed?'), 'notification text excludes erased output')

    proc.output(clear + '1. First result\r\n2. Second result\r\n\r\nOverwrite file? [y/N]')
    await pause()
    assert.equal(ptys.getPtySession(id).needsApproval, true, `${agent}: real y/n prompts still work`)
    proc.output(clear + 'Done.\r\n' + marker + ' ')
    await pause()
    assert.equal(ptys.getPtySession(id).needsApproval, false)

    // Old menus in scrollback or inside quoted code must never re-arm the notification.
    proc.output(clear + 'Do you want to proceed?\r\n' + marker + ' 1. Yes\r\n  2. No\r\n' + '\r\n'.repeat(45) + 'Done.\r\n' + marker + ' ')
    await pause()
    assert.equal(ptys.getPtySession(id).needsApproval, false)
    proc.output(clear + 'Example:\r\n```text\r\nAllow command?\r\n' + marker + ' 1. Yes\r\n  2. No\r\n```')
    await pause()
    assert.equal(ptys.getPtySession(id).needsApproval, false)
    assert.equal(alerts, 2, `${agent}: only the two actual prompts notify`)
    proc.exit({ exitCode: 0 })
  }
  console.log('approval detection: ordinary output / live rendered menus / split chunks / navigation / automatic clearing / history passed for Claude and Codex')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
