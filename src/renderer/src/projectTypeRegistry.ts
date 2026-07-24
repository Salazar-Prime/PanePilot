import type { ComponentType } from 'react'
import type { Connection, Project, ProjectType } from '@shared/types'
import { TerminalProjectWorkspace } from './components/TerminalProjectWorkspace'

export interface ProjectWorkspaceProps {
  project: Project
  connection: Connection | undefined
  selectedSessionId: string | null
  onSelectSession(id: string): void
  onChanged(): Promise<void>
}

export interface ProjectTypeDefinition {
  id: ProjectType
  label: string
  description: string
  capabilities: Array<'terminal' | 'files' | 'repository' | 'agent-history'>
  Workspace: ComponentType<ProjectWorkspaceProps>
}

export const projectTypeRegistry: Record<ProjectType, ProjectTypeDefinition> = {
  terminal: {
    id: 'terminal',
    label: 'Terminal',
    description: 'Shell and coding-agent workspaces',
    capabilities: ['terminal', 'files', 'repository', 'agent-history'],
    Workspace: TerminalProjectWorkspace
  }
}
