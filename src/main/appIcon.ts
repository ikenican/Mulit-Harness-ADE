// 視窗與通知用的 App 圖示（exe／安裝檔的圖示由 electron-builder 從 build/icon.ico 打進去）。
// 圖檔由 scripts/gen-app-icons.ps1 產生；?asset 讓 electron-vite 把檔案複製進 out，打包後也找得到。
import iconIco from '../../build/icon.ico?asset'
import iconPng from '../../build/icon.png?asset'

export const appIconPath = process.platform === 'win32' ? iconIco : iconPng
