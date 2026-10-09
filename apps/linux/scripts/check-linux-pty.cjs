const assert = require('node:assert/strict')
const path = require('node:path')
const pty = process.argv[2]
  ? require(path.resolve(process.argv[2], 'resources/app.asar/node_modules/@lydell/node-pty'))
  : require('@lydell/node-pty')

assert.equal(process.platform, 'linux', 'Run this native smoke check on Linux')
let output = ''
const terminal = pty.spawn('/bin/bash', ['-c', 'printf "LINUX_PTY_READY"'], {
  name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env: process.env
})
terminal.onData(data => { output += data })
const timeout = setTimeout(() => { terminal.kill(); throw new Error('Linux PTY smoke check timed out') }, 5000)
terminal.onExit(({ exitCode }) => {
  clearTimeout(timeout)
  assert.equal(exitCode, 0)
  assert.match(output, /LINUX_PTY_READY/)
  console.log('Linux native PTY started, produced output and exited successfully')
})
