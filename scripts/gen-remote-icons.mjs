// 產生 iPhone 遠端控制 PWA 的主畫面圖示（src/renderer/public/remote-icon-*.png）。
// 不依賴任何影像套件：直接算像素、用 zlib 寫 PNG。執行：node scripts/gen-remote-icons.mjs
import { writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

// 線段距離：畫 ">" 與 "_" 的粗線
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

function render(size) {
  const SS = 4 // 超取樣抗鋸齒
  const rows = []
  const stroke = 0.075
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3)
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size
          const v = (y + (sy + 0.5) / SS) / size
          // 背景：左上靛藍 → 右下紫
          const tt = (u + v) / 2
          let cr = 55 + (124 - 55) * tt, cg = 48 + (58 - 48) * tt, cb = 163 + (237 - 163) * tt
          const d = Math.min(
            distSeg(u, v, 0.27, 0.33, 0.47, 0.5),
            distSeg(u, v, 0.47, 0.5, 0.27, 0.67),
            distSeg(u, v, 0.55, 0.68, 0.74, 0.68)
          )
          if (d < stroke / 2) (cr = 255), (cg = 255), (cb = 255)
          r += cr; g += cg; b += cb
        }
      }
      const n = SS * SS
      row[1 + x * 3] = Math.round(r / n)
      row[2 + x * 3] = Math.round(g / n)
      row[3 + x * 3] = Math.round(b / n)
    }
    rows.push(row)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB（iOS 圖示不需要透明，會自己套圓角）
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

for (const size of [180, 512]) {
  writeFileSync(new URL(`../src/renderer/public/remote-icon-${size}.png`, import.meta.url), render(size))
}
console.log('wrote remote-icon-180.png, remote-icon-512.png')
