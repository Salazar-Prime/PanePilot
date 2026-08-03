import type { ComponentType } from 'react'
import type {
  Connection,
  Project,
  ProjectType,
  TerminalTransportState
} from '@shared/types'
import { LatexProjectWorkspace } from './components/LatexProjectWorkspace'
import { TerminalProjectWorkspace } from './components/TerminalProjectWorkspace'

export interface ProjectWorkspaceProps {
  project: Project
  connection: Connection | undefined
  selectedSessionId: string | null
  launchTerminalRequest: number
  openSessionRequest: number
  terminalTransportStates: Record<string, TerminalTransportState>
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
      'agent-history',
      'terminal'
    ],
    Workspace: LatexProjectWorkspace,
    createFields: ['folder', 'repository', 'main-file', 'overleaf', 'context-folder']
  }
}
