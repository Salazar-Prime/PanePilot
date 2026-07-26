import {
  copyFileSync,
  closeSync,
  lstatSync,
  openSync,
  promises as fs,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import type { FileEntry, FileOpenResult, FilePreview } from '../shared/types'

const PREVIEW_LIMIT = 1024 * 1024
const SEARCH_RESULT_LIMIT = 200
const SEARCH_SCAN_LIMIT = 20_000
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp'
}

function boundedPath(root: string, requested = '.'): string {
  const realRoot = realpathSync(root)
  const candidate = realpathSync(resolve(realRoot, requested))
  if (candidate !== realRoot && !candidate.startsWith(`${realRoot}${sep}`)) {
    throw new Error('The requested path is outside the project folder.')
  }
  return candidate
}

export function listLocalFiles(root: string, requested = '.'): FileEntry[] {
  const realRoot = realpathSync(root)
  const directory = boundedPath(root, requested)
  if (!statSync(directory).isDirectory()) throw new Error('The requested path is not a directory.')

  return readdirSync(directory)
    .filter((name) => name !== '.git' && name !== 'node_modules')
    .flatMap((name): FileEntry[] => {
      const rawPath = resolve(directory, name)
      try {
        const target = boundedPath(root, relative(realRoot, rawPath))
        const stat = lstatSync(target)
        return [
          {
            name,
            path: relative(realRoot, target) || '.',
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

export async function searchLocalFiles(
  root: string,
  rawQuery: string
): Promise<FileEntry[]> {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return []
  const realRoot = await fs.realpath(root)
  const results: FileEntry[] = []
  const directories = [realRoot]
  const visited = new Set<string>()
  let scanned = 0

  while (
    directories.length > 0 &&
    results.length < SEARCH_RESULT_LIMIT &&
    scanned < SEARCH_SCAN_LIMIT
  ) {
    const directory = directories.shift()!
    if (visited.has(directory)) continue
    visited.add(directory)
    let entries
    try {
      entries = await fs.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (
        scanned >= SEARCH_SCAN_LIMIT ||
        results.length >= SEARCH_RESULT_LIMIT
      ) {
        break
      }
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      scanned += 1
      const unresolved = resolve(directory, entry.name)
      let target: string
      try {
        target = await fs.realpath(unresolved)
      } catch {
        continue
      }
      if (target !== realRoot && !target.startsWith(`${realRoot}${sep}`)) continue
      const projectPath = relative(realRoot, target)
      let stat
      try {
        stat = await fs.stat(target)
      } catch {
        continue
      }
      const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : null
      if (!kind) continue
      if (projectPath.toLocaleLowerCase().includes(query)) {
        results.push({
          name: entry.name,
          path: projectPath,
          kind,
          size: kind === 'file' ? stat.size : null
        })
      }
      if (kind === 'directory' && !visited.has(target)) directories.push(target)
    }
  }

  return results.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

export function previewLocalFile(root: string, requested: string): FilePreview {
  const filePath = boundedPath(root, requested)
  const stat = statSync(filePath)
  if (!stat.isFile()) throw new Error('The requested path is not a file.')
  const buffer = Buffer.allocUnsafe(Math.min(stat.size, PREVIEW_LIMIT))
  const descriptor = openSync(filePath, 'r')
  let bytesRead = 0
  try {
    bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
  } finally {
    closeSync(descriptor)
  }
  const bytes = buffer.subarray(0, bytesRead)
  const imageMimeType = IMAGE_MIME_TYPES[extname(filePath).toLocaleLowerCase()] ?? null
  const imageDataUrl =
    imageMimeType && stat.size <= PREVIEW_LIMIT
      ? `data:${imageMimeType};base64,${bytes.toString('base64')}`
      : null
  const binary = Boolean(imageMimeType) || bytes.includes(0)
  return {
    path: requested,
    content: binary ? '' : bytes.toString('utf8'),
    truncated: stat.size > PREVIEW_LIMIT,
    binary,
    imageMimeType,
    imageDataUrl
  }
}

export function openLocalPath(root: string, requested: string): FileOpenResult {
  const target = boundedPath(root, requested)
  const stat = statSync(target)
  if (stat.isDirectory()) {
    return {
      kind: 'directory',
      path: requested,
      directoryPath: requested,
      entries: listLocalFiles(root, requested),
      preview: null
    }
  }
  if (!stat.isFile()) {
    throw new Error(`The requested path is not a file or directory: ${requested}`)
  }
  const directoryPath = dirname(requested) || '.'
  return {
    kind: 'file',
    path: requested,
    directoryPath,
    entries: listLocalFiles(root, directoryPath),
    preview: previewLocalFile(root, requested)
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
