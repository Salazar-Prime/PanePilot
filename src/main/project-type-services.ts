import { existsSync, statSync } from 'node:fs'
import type { Connection, CreateProjectInput, ProjectType } from '../shared/types'

export interface ProjectTypeService {
  type: ProjectType
  validateCreate(input: CreateProjectInput, connection: Connection): void
}

const terminalProjectService: ProjectTypeService = {
  type: 'terminal',
  validateCreate(input, connection) {
    if (!input.name.trim()) throw new Error('Project name is required.')
    if (!input.folder.trim()) throw new Error('Project folder is required.')
    if (connection.kind === 'local') {
      if (!existsSync(input.folder) || !statSync(input.folder).isDirectory()) {
        throw new Error('Choose an existing local folder.')
      }
    }
  }
}

export const projectTypeServices = new Map<ProjectType, ProjectTypeService>([
  [terminalProjectService.type, terminalProjectService]
])
