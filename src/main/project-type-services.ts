import { existsSync, realpathSync, statSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import type {
  Connection,
  CreateProjectInput,
  Project,
  ProjectType
} from '../shared/types'
import { discoverRepository } from './git'
import {
  createLocalDirectory,
  createLocalFile,
  previewLocalFile,
  writeLocalFile
} from './file-service'
import {
  normalizeOptionalWebUrl,
  normalizeProjectRelativePath
} from './latex-paths'
import {
  createRemoteDirectory,
  createRemoteFile,
  listRemoteFolders,
  previewRemoteFile,
  writeRemoteFileAsync
} from './remote-file-service'
import type { Store } from './store'

export interface ProjectTypeService {
  type: ProjectType
  create(
    store: Store,
    input: CreateProjectInput,
    connection: Connection
  ): Promise<Project>
}

interface ResolvedProjectFolder {
  folder: string
  created: boolean
}

const STARTER_LATEX_DOCUMENT = String.raw`\documentclass{article}

\begin{document}

\end{document}
`

function validateBaseInput(input: CreateProjectInput): void {
  if (!input.name.trim()) throw new Error('Project name is required.')
  if (!input.folder.trim()) throw new Error('Project folder is required.')
  if (input.newFolderName != null && !input.newFolderName.trim()) {
    throw new Error('New folder name is required.')
  }
}

async function resolveProjectFolder(
  input: CreateProjectInput,
  connection: Connection
): Promise<ResolvedProjectFolder> {
  const folder = input.folder.trim()
  const newFolderName = input.newFolderName?.trim()
  if (connection.kind === 'local') {
    if (!existsSync(folder) || !statSync(folder).isDirectory()) {
      throw new Error(
        newFolderName
          ? 'Choose an existing local parent folder.'
          : 'Choose an existing local folder.'
      )
    }
    if (!newFolderName) return { folder, created: false }
    const createdPath = createLocalDirectory(folder, '.', newFolderName)
    return {
      folder: realpathSync(resolve(folder, createdPath)),
      created: true
    }
  }
  if (!connection.sshAlias) throw new Error('The SSH connection has no alias.')
  const parent = listRemoteFolders(connection.sshAlias, folder).currentPath
  if (!newFolderName) return { folder: parent, created: false }
  const createdPath = await createRemoteDirectory(
    connection.sshAlias,
    parent,
    '.',
    newFolderName
  )
  return {
    folder: listRemoteFolders(
      connection.sshAlias,
      posix.join(parent, createdPath)
    ).currentPath,
    created: true
  }
}

function repositoryFor(
  explicitRepository: string | null,
  connection: Connection,
  folder: string
): string | null {
  return (
    explicitRepository ??
    (connection.kind === 'local' ? discoverRepository(folder) : null)
  )
}

async function createStarterLatexFile(
  connection: Connection,
  folder: string,
  mainFile: string
): Promise<void> {
  const parts = mainFile.split('/')
  const fileName = parts.pop()!
  let parentPath = '.'
  for (const part of parts) {
    if (connection.kind === 'local') {
      parentPath = createLocalDirectory(folder, parentPath, part)
    } else {
      if (!connection.sshAlias) throw new Error('The SSH connection has no alias.')
      parentPath = await createRemoteDirectory(
        connection.sshAlias,
        folder,
        parentPath,
        part
      )
    }
  }

  if (connection.kind === 'local') {
    createLocalFile(folder, parentPath, fileName)
    writeLocalFile(folder, mainFile, STARTER_LATEX_DOCUMENT)
    return
  }
  if (!connection.sshAlias) throw new Error('The SSH connection has no alias.')
  await createRemoteFile(connection.sshAlias, folder, parentPath, fileName)
  await writeRemoteFileAsync(
    connection.sshAlias,
    folder,
    mainFile,
    STARTER_LATEX_DOCUMENT
  )
}

const terminalProjectService: ProjectTypeService = {
  type: 'terminal',
  async create(store, input, connection) {
    if (input.type !== 'terminal') throw new Error('Invalid terminal project settings.')
    validateBaseInput(input)
    const explicitRepository = normalizeOptionalWebUrl(
      input.repositoryUrl,
      'Repository URL'
    )
    const { folder } = await resolveProjectFolder(input, connection)
    return store.createProject({
      type: 'terminal',
      name: input.name.trim(),
      connectionId: input.connectionId,
      folder,
      repositoryUrl: repositoryFor(explicitRepository, connection, folder)
    })
  }
}

const latexProjectService: ProjectTypeService = {
  type: 'latex',
  async create(store, input, connection) {
    if (input.type !== 'latex') throw new Error('Invalid LaTeX project settings.')
    validateBaseInput(input)
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
    const explicitRepository = normalizeOptionalWebUrl(
      input.repositoryUrl,
      'Repository URL'
    )
    const { folder, created } = await resolveProjectFolder(input, connection)
    if (created) await createStarterLatexFile(connection, folder, mainFile)
    let preview
    try {
      preview =
        connection.kind === 'local'
          ? previewLocalFile(folder, mainFile)
          : previewRemoteFile(
              connection.sshAlias ?? connection.name,
              folder,
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
      folder,
      repositoryUrl: repositoryFor(explicitRepository, connection, folder),
      latex: { mainFile, overleafUrl, contextFolder }
    })
  }
}

export const projectTypeServices = new Map<ProjectType, ProjectTypeService>([
  [terminalProjectService.type, terminalProjectService],
  [latexProjectService.type, latexProjectService]
])
