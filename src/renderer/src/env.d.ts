/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Interactive HTML capability creation/revocation is exposed only to the app's main frame.
  }
}

export {}
