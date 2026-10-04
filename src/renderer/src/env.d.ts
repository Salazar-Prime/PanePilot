/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes typed terminalDrops and files.importFiles bridges.
  }
}

export {}
