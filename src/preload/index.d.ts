import type { CueApi } from './index'

declare global {
  interface Window {
    cue: CueApi
  }
}

export {}
