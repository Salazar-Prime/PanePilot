/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes terminal archive/restore, guarded LaTeX source IO, and fixed-feed updates.
  }
}

export {}
