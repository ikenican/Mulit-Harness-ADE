/// <reference types="vite/client" />

// Monaco 會讀 window.MonacoEnvironment 決定各語言 worker 怎麼建立
declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker: (workerId: string, label: string) => Worker
    }
  }
}

export {}
