import { existsSync, statSync } from 'node:fs'
import type {
  Connection,
  CreateProjectInput,
  Project,
  ProjectType
} from '../shared/types'
import { discoverRepository } from './git'
import { previewLocalFile } from './file-service'
import {
  normalizeOptionalWebUrl,
  normalizeProjectRelativePath
} from './latex-paths'
import { previewRemoteFile } from './remote-file-service'
import type { Store } from './store'

export interface ProjectTypeService {
  type: ProjectType
  create(store: Store, input: CreateProjectInput, connection: Connection): Project
}

function validateBase(input: CreateProjectInput, connection: Connection): void {
  if (!input.name.trim()) throw new Error('Project name is required.')
  if (!input.folder.trim()) throw new Error('Project folder is required.')
  if (
    connection.kind === 'local' &&
    (!existsSync(input.folder) || !statSync(input.folder).isDirectory())
  ) {
    throw new Error('Choose an existing local folder.')
  }
}

function repositoryFor(input: CreateProjectInput, connection: Connection): string | null {
  return (
    normalizeOptionalWebUrl(input.repositoryUrl, 'Repository URL') ??
    (connection.kind === 'local' ? discoverRepository(input.folder) : null)
  )
}

const terminalProjectService: ProjectTypeService = {
  type: 'terminal',
  create(store, input, connection) {
    if (input.type !== 'terminal') throw new Error('Invalid terminal project settings.')
    validateBase(input, connection)
    return store.createProject({
      type: 'terminal',
      name: input.name.trim(),
      connectionId: input.connectionId,
      folder: input.folder.trim(),
      repositoryUrl: repositoryFor(input, connection)
    })
  }
}

const latexProjectService: ProjectTypeService = {
  type: 'latex',
  create(store, input, connection) {
    if (input.type !== 'latex') throw new Error('Invalid LaTeX project settings.')
    validateBase(input, connection)
    const mainFile = normalizeProjectRelativePath(
      input.latex.mainFile || 'main.tex',
      'Main LaTeX file',
      { extension: '.tex' }
    )
    const contextFolder = normalizeProjectRelativePath(
      input.latex.contextFolder || 'context',
      'Context folder'
    )
    const overleafUrl = normalizeOptionalWebUrl(input.latex.overleafUrl, 'Overleaf URL')
    let preview
    try {
      preview =
        connection.kind === 'local'
          ? previewLocalFile(input.folder, mainFile)
          : previewRemoteFile(
              connection.sshAlias ?? connection.name,
              input.folder,
              mainFile
            )
    } catch {
      throw new Error(`Main LaTeX file “${mainFile}” was not found.`)
    }
    if (preview.binary || preview.truncated) {
      throw new Error('The main LaTeX file must be UTF-8 text no larger than 1 MB.')
    }
    return store.createProject({
      type: 'latex',
      name: input.name.trim(),
      connectionId: input.connectionId,
      folder: input.folder.trim(),
      repositoryUrl: repositoryFor(input, connection),
      latex: { mainFile, overleafUrl, contextFolder }
    })
  }
}

export const projectTypeServices = new Map<ProjectType, ProjectTypeService>([
  [terminalProjectService.type, terminalProjectService],
  [latexProjectService.type, latexProjectService]
])
