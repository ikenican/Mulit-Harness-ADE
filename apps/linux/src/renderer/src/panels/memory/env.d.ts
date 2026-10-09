import type { WorkbenchApi } from '../../../../preload'

declare global {
  interface Window {
    api: WorkbenchApi
  }
}

export {}
