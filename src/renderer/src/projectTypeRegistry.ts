import type { ComponentType } from 'react'
import type {
  Connection,
  Project,
  ProjectType,
  TerminalSession,
  TerminalTransportState
} from '@shared/types'
import { LatexProjectWorkspace } from './components/LatexProjectWorkspace'
import { TerminalProjectWorkspace } from './components/TerminalProjectWorkspace'

export interface ProjectWorkspaceProps {
  project: Project
  connection: Connection | undefined
  selectedSessionId: string | null
  launchTerminalRequest: number | null
  openSessionRequest: number | null
  terminalTransportStates: Record<string, TerminalTransportState>
  openSessionIds: Set<string>
  onOpenSession(id: string): void
  onCloseSession(id: string): void
  onSessionSelected(id: string): void
  onLaunchTerminalRequestHandled(id: number): void
  onOpenSessionRequestHandled(id: number): void
  onSwapPanes?(): void
  onTransferSession?(session: TerminalSession): void
  onSelectSession(id: string): void
  onChanged(): Promise<void>
}

export interface ProjectTypeDefinition {
  id: ProjectType
  label: string
  description: string
  capabilities: Array<
    | 'terminal'
    | 'files'
    | 'repository'
    | 'git'
    | 'agent-history'
    | 'latex-editor'
    | 'agent-chat'
    | 'actions'
    | 'project-qna'
    | 'context'
    | 'notes'
    | 'google-drive'
  >
  Workspace: ComponentType<ProjectWorkspaceProps>
  createFields: Array<
    'folder' | 'repository' | 'main-file' | 'overleaf' | 'context-folder'
  >
}

export const projectTypeRegistry: Record<ProjectType, ProjectTypeDefinition> = {
  terminal: {
    id: 'terminal',
    label: 'Terminal',
    description: 'Shell and coding-agent workspaces',
    capabilities: [
      'terminal',
      'actions',
      'project-qna',
      'notes',
      'files',
      'google-drive',
      'repository',
      'git',
      'agent-history'
    ],
    Workspace: TerminalProjectWorkspace,
    createFields: ['folder', 'repository']
  },
  latex: {
    id: 'latex',
    label: 'LaTeX',
    description: 'Section-aware papers with attached writing agents',
    capabilities: [
      'latex-editor',
      'agent-chat',
      'actions',
      'project-qna',
      'notes',
      'context',
      'files',
      'google-drive',
      'repository',
      'git',
      'agent-history',
      'terminal'
    ],
    Workspace: LatexProjectWorkspace,
    createFields: ['folder', 'repository', 'main-file', 'overleaf', 'context-folder']
  }
}
