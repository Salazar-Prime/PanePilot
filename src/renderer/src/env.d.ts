/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes guarded LaTeX source reads/saves and fixed-feed Sparkle controls.
  }
}

export {}
