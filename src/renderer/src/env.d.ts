/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes session-wide chat trimming through conversations.list, and read-only previews/sub-agents.
  }
}

export {}
