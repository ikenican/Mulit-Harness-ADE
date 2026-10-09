import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// ponytail: node-pty / simple-git 是 main-process 原生/Node 相依，靠 externalizeDepsPlugin 排除打包
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@panels': resolve('src/renderer/src/panels')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // 第二個 entry：iPhone 遠端控制 PWA，由 main 的 Remote Bridge 以 https 提供給手機
        input: {
          index: resolve('src/renderer/index.html'),
          remote: resolve('src/renderer/remote.html')
        }
      }
    }
  }
})
