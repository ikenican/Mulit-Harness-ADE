// 自我檢查：node --experimental-strip-types scripts/check-portDetect.mts
import assert from 'node:assert'
import { detectDevPort, detectDevUrl } from '../src/shared/portDetect.ts'

// Vite 彩色輸出：port 被 ANSI 切開也要抓得到
assert.equal(
  detectDevUrl('  \x1b[32m➜\x1b[39m  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'),
  'http://localhost:5173/'
)
assert.equal(detectDevUrl('ready on http://0.0.0.0:3000.'), 'http://localhost:3000')
assert.equal(detectDevUrl('see http://localhost:80'), null) // <1024 忽略
assert.equal(detectDevUrl('https://localhost:8443'), null) // https 忽略
assert.equal(detectDevUrl('no url here'), null)

// 手機預覽只要 port（桌面用它反向代理到 127.0.0.1:port）
assert.equal(detectDevPort('  ➜  Local:   http://localhost:5173/'), 5173)
assert.equal(detectDevPort('ready on http://0.0.0.0:3000.'), 3000)
assert.equal(detectDevPort('先 http://localhost:5173/ 後來換 http://127.0.0.1:4321/'), 4321) // 取最後一個
assert.equal(detectDevPort('see http://localhost:80'), null)
assert.equal(detectDevPort('no url here'), null)
console.log('portDetect ok')
