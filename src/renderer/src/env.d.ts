/// <reference types="vite/client" />

import type { ProjectConsoleApi } from '../../shared/types'

declare global {
  interface Window {
    projectConsole: ProjectConsoleApi // Includes power saving and local Electron/tmux/agent memory, Markdown history, guarded LaTeX IO, and updates.
  }
}

export {}
