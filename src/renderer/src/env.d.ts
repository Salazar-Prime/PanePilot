/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes power saving, Markdown history, terminal recovery, guarded LaTeX IO, and updates.
  }
}

export {}
