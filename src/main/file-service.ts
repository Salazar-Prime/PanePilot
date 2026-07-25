import {
  copyFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import type { FileEntry, FilePreview } from '../shared/types'

const PREVIEW_LIMIT = 1024 * 1024

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
