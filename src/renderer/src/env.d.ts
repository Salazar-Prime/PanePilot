/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes app-wide Quick Notes and read-only terminal previews/sub-agents.
  }
}

export {}
