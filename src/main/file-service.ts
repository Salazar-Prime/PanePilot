import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import type { FileEntry, FilePreview, ProjectNotes } from '../shared/types'

const PREVIEW_LIMIT = 1024 * 1024
const PROJECT_NOTES_PATH = '.notes-panepilot'

function boundedPath(root: string, requested = '.'): string {
  const realRoot = realpathSync(root)
  const candidate = realpathSync(resolve(realRoot, requested))
  if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${sep}`)) {
    throw new Error('The requested path is outside the project folder.')
  }
  return candidate
}

export function listLocalFiles(root: string, requested = '.'): FileEntry[] {
  const directory = boundedPath(root, requested)
  if (!statSync(directory).isDirectory()) throw new Error('The requested path is not a directory.')

  return readdirSync(directory)
    .filter((name) => name !== '.git' && name !== 'node_modules')
    .flatMap((name): FileEntry[] => {
      const rawPath = resolve(directory, name)
      try {
        const target = boundedPath(root, relative(root, rawPath))
        const stat = lstatSync(target)
        return [
          {
            name,
            path: relative(realpathSync(root), target) || '.',
            kind: stat.isDirectory() ? 'directory' : 'file',
            size: stat.isFile() ? stat.size : null
          }
        ]
      } catch {
        return []
      }
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}

export function previewLocalFile(root: string, requested: string): FilePreview {
  const filePath = boundedPath(root, requested)
  const stat = statSync(filePath)
  if (!stat.isFile()) throw new Error('The requested path is not a file.')
  const bytes = readFileSync(filePath).subarray(0, PREVIEW_LIMIT)
  const binary = bytes.includes(0)
  return {
    path: requested,
    content: binary ? '' : bytes.toString('utf8'),
    truncated: stat.size > PREVIEW_LIMIT,
    binary
  }
}

export function writeLocalFile(root: string, requested: string, content: string): void {
  const filePath = boundedPath(root, requested)
  if (!statSync(filePath).isFile()) throw new Error('The requested path is not a file.')
  if (Buffer.byteLength(content, 'utf8') > PREVIEW_LIMIT) {
    throw new Error('PanePilot only edits files up to 1 MB.')
  }
  writeFileSync(filePath, content, 'utf8')
}

export function downloadLocalFile(
  root: string,
  requested: string,
  destination: string
): void {
  const filePath = boundedPath(root, requested)
  if (!statSync(filePath).isFile()) {
    throw new Error('The requested path is not a file.')
  }
  copyFileSync(filePath, destination)
}

function localProjectNotesPath(root: string): string {
  const realRoot = realpathSync(root)
  if (!statSync(realRoot).isDirectory()) {
    throw new Error('The project folder does not exist.')
  }
  const notesPath = resolve(realRoot, PROJECT_NOTES_PATH)
  const existing = lstatSync(notesPath, { throwIfNoEntry: false })
  if (existing) {
    const stat = existing
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `${PROJECT_NOTES_PATH} must be a regular file inside the project folder.`
      )
    }
  }
  return notesPath
}

export function readLocalProjectNotes(root: string): ProjectNotes {
  const notesPath = localProjectNotesPath(root)
  if (!existsSync(notesPath)) {
    return { path: PROJECT_NOTES_PATH, content: '', exists: false }
  }
  const stat = statSync(notesPath)
  if (stat.size > PREVIEW_LIMIT) {
    throw new Error('Project notes must be 1 MB or smaller.')
  }
  const content = readFileSync(notesPath)
  if (content.includes(0)) {
    throw new Error('Project notes must be UTF-8 Markdown text.')
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error('Project notes must be UTF-8 Markdown text.')
  }
  return {
    path: PROJECT_NOTES_PATH,
    content: decoded,
    exists: true
  }
}

export function writeLocalProjectNotes(
  root: string,
  content: string
): ProjectNotes {
  if (Buffer.byteLength(content, 'utf8') > PREVIEW_LIMIT) {
    throw new Error('Project notes must be 1 MB or smaller.')
  }
  const notesPath = localProjectNotesPath(root)
  const temporaryPath = resolve(
    realpathSync(root),
    `.${PROJECT_NOTES_PATH}.${randomUUID()}.tmp`
  )
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, notesPath)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
  return { path: PROJECT_NOTES_PATH, content, exists: true }
}
