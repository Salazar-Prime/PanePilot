/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes fixed-feed Sparkle controls; the bridge is exposed only to the app's main frame.
  }
}

export {}
