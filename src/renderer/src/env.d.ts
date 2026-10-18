/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes read-only file previews and lightweight sub-agent presence checks.
  }
}

export {}
