# 啟動 Agent Workbench 開發版（從原始碼直接跑，不用打包）
# 用法：雙擊同資料夾的 dev.cmd（Windows 預設禁止直接執行 .ps1），
#       或在 PowerShell 執行：powershell -ExecutionPolicy Bypass -File .\dev.ps1
# 開發版的設定存在 %APPDATA%\agent-workbench-dev，跟已安裝的 Workbench 分開，可以同時開。
# 視窗開著時改 src/renderer 會自動刷新；改 src/main 會自動重啟。關掉這個視窗或按 Ctrl+C 結束。

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# 這台電腦的 Node.js / Git 是後來用 winget 裝的，舊的終端機 PATH 可能還沒有它們
foreach ($p in 'C:\Program Files\nodejs', 'C:\Program Files\Git\cmd') {
  if ((Test-Path $p) -and -not (($env:Path -split ';') -contains $p)) { $env:Path = "$p;$env:Path" }
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Host '找不到 npm。請先安裝 Node.js LTS：winget install OpenJS.NodeJS.LTS' -ForegroundColor Red
  Read-Host '按 Enter 關閉'
  exit 1
}

if (-not (Test-Path (Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'))) {
  Write-Host '第一次執行：安裝相依套件（npm install），需要幾分鐘…' -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { Write-Host 'npm install 失敗，請看上面的錯誤訊息。' -ForegroundColor Red; Read-Host '按 Enter 關閉'; exit 1 }
}

Write-Host '啟動開發版 Agent Workbench…（關閉這個視窗或按 Ctrl+C 結束）' -ForegroundColor Green
npm run dev
if ($LASTEXITCODE -ne 0) { Write-Host "開發版結束，代碼 $LASTEXITCODE" -ForegroundColor Yellow; Read-Host '按 Enter 關閉' }