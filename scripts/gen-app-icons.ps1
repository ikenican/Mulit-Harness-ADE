# App icons from build/icon-source.png (Windows PowerShell 5.1, System.Drawing; no extra tools).
#   powershell -ExecutionPolicy Bypass -File scripts/gen-app-icons.ps1
# Outputs:
#   build/icon.png   1024 px, transparent corners (electron-builder derives the macOS/Linux icons from it)
#   build/icon.ico   16-256 px (Windows exe, installer, taskbar, jump list)
#   src/renderer/public/remote-icon-180.png / -512.png   full-bleed squares for the phone PWA (iOS rounds them itself)
# The source tile has a ragged white fringe outside its rounded square, so the tile is located and re-masked
# with a clean anti-aliased rounded rectangle instead of using the source alpha.
param([string]$Source = "$PSScriptRoot/../build/icon-source.png")
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Resolve-Path "$PSScriptRoot/.."
$src = New-Object System.Drawing.Bitmap (Resolve-Path $Source).Path

# ── locate the tile: first/last opaque pixel on the middle row and column ──
$alpha = { param($x, $y) $src.GetPixel($x, $y).A }
$midY = [int]($src.Height / 2); $midX = [int]($src.Width / 2)
$left = 0; while ((& $alpha $left $midY) -lt 200) { $left++ }
$right = $src.Width - 1; while ((& $alpha $right $midY) -lt 200) { $right-- }
$top = 0; while ((& $alpha $midX $top) -lt 200) { $top++ }
$bottom = $src.Height - 1; while ((& $alpha $midX $bottom) -lt 200) { $bottom-- }
$diag = 0; while ((& $alpha ($left + $diag) ($top + $diag)) -lt 200) { $diag++ }
$radius = $diag / (1 - 1 / [math]::Sqrt(2))   # a rounded corner meets the diagonal r(1-1/sqrt2) from the corner
$tileW = $right - $left + 1; $tileH = $bottom - $top + 1
Write-Host "tile ${tileW}x${tileH} at ($left,$top), corner radius $([math]::Round($radius))"

function New-Canvas([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
  return @($bmp, $g)
}

function RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90); $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90); $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}

# ── master: tile kept at its own aspect ratio, centred, clean rounded mask, opaque inside ──
$size = 1024
$scale = ($size * 0.96) / [math]::Max($tileW, $tileH)
$dw = $tileW * $scale; $dh = $tileH * $scale
$dx = ($size - $dw) / 2; $dy = ($size - $dh) / 2
$inset = 3   # source px trimmed off each edge (the tile border is slightly ragged too)
$tile = New-Object System.Drawing.Bitmap $tileW, $tileH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$tg = [System.Drawing.Graphics]::FromImage($tile)
$tg.Clear([System.Drawing.Color]::FromArgb(255, 241, 240, 242))   # tile background behind the semi-transparent source
$tg.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $tileW, $tileH), $left, $top, $tileW, $tileH, [System.Drawing.GraphicsUnit]::Pixel)
$tg.Dispose()
$master, $g = New-Canvas $size
$brush = New-Object System.Drawing.TextureBrush $tile
$m = New-Object System.Drawing.Drawing2D.Matrix
$m.Translate($dx, $dy); $m.Scale($scale, $scale)
$brush.Transform = $m
$g.FillPath($brush, (RoundedPath ($dx + $inset * $scale) ($dy + $inset * $scale) ($dw - 2 * $inset * $scale) ($dh - 2 * $inset * $scale) (($radius - $inset) * $scale)))
$g.Dispose()
New-Item -ItemType Directory -Force "$root/build" | Out-Null
$master.Save("$root/build/icon.png", [System.Drawing.Imaging.ImageFormat]::Png)

function Resize([System.Drawing.Bitmap]$img, [int]$s) {
  $b, $gr = New-Canvas $s
  $gr.DrawImage($img, 0, 0, $s, $s); $gr.Dispose(); return $b
}

# ── icon.ico: PNG-compressed entries (Vista+), 256 px max ──
$sizes = 16, 20, 24, 32, 40, 48, 64, 96, 128, 256
$pngs = foreach ($s in $sizes) { $b = Resize $master $s; $ms = New-Object System.IO.MemoryStream; $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose(); , $ms.ToArray() }
$fs = [System.IO.File]::Create("$root/build/icon.ico")
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $dim = if ($s -ge 256) { 0 } else { $s }
  $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Close()

# ── phone PWA: opaque full-bleed square cut from the tile interior (inside the rounded corners) ──
$cut = [int]($radius * (1 - 1 / [math]::Sqrt(2))) + 8
$side = [math]::Min($tileW, $tileH) - 2 * $cut
$cx = $left + [int](($tileW - $side) / 2); $cy = $top + [int](($tileH - $side) / 2)
foreach ($s in 180, 512) {
  $b, $gr = New-Canvas $s
  $gr.Clear([System.Drawing.Color]::FromArgb(255, 241, 240, 242))
  $gr.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $s, $s), $cx, $cy, $side, $side, [System.Drawing.GraphicsUnit]::Pixel)
  $gr.Dispose()
  $b.Save("$root/src/renderer/public/remote-icon-$s.png", [System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
}
$master.Dispose(); $tile.Dispose(); $src.Dispose()
Write-Host 'wrote build/icon.png, build/icon.ico, src/renderer/public/remote-icon-180.png, remote-icon-512.png'
