// 自我檢查：node --experimental-strip-types scripts/check-portDetect.mts
import assert from 'node:assert'
import { detectDevUrl } from '../src/renderer/src/panels/terminal/portDetect.ts'

// Vite 彩色輸出：port 被 ANSI 切開也要抓得到
assert.equal(
  detectDevUrl('  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'),
  'http://localhost:5173/'
)
assert.equal(detectDevUrl('ready on http://0.0.0.0:3000.'), 'http://localhost:3000')
assert.equal(detectDevUrl('see http://localhost:80'), null) // <1024 忽略
assert.equal(detectDevUrl('https://localhost:8443'), null) // https 忽略
assert.equal(detectDevUrl('no url here'), null)
console.log('portDetect ok')
