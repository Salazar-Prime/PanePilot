/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes typed terminal drops, file imports, and Codex sub-agent snapshots.
  }
}

export {}
