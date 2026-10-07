/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes read-only terminal previews and Codex sub-agent snapshots.
  }
}

export {}
