import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

export interface TerminalFileTarget {
  path: string
  line: number | null
  column: number | null
}

export interface ProjectFileOpenRequest extends TerminalFileTarget {
  projectId: string
  requestId: number
}

interface ParsedTerminalFileLink {
  startIndex: number
  text: string
  target: TerminalFileTarget
}

const FILE_REFERENCE_PATTERN =
  /(^|[\s(\[{"'`])((?:file:\/\/)?(?:\/|\.{1,2}\/)?[A-Za-z0-9_@%+~.-]+(?:\/[A-Za-z0-9_@%+~.-]+)*)(?::(\d+)(?::(\d+))?|\((\d+)(?:,(\d+))?\)|#L(\d+)(?:C(\d+))?)?/g

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

function looksLikeFilePath(path: string): boolean {
  if (
    path.startsWith('/') ||
    path.startsWith('./') ||
    path.startsWith('../') ||
    path.startsWith('file://') ||
    path.includes('/')
  ) {
    return true
  }
  const name = path.split('/').at(-1) ?? ''
  return (
    name.startsWith('.') ||
    name.includes('.') ||
    ['Dockerfile', 'LICENSE', 'Makefile', 'README'].includes(name)
  )
}

export function normalizeTerminalFilePath(
  rawPath: string,
  projectFolder: string
): string | null {
  let path = rawPath
  if (path.startsWith('file://')) {
    try {
      const url = new URL(path)
      if (url.protocol !== 'file:') return null
      path = decodeURIComponent(url.pathname)
    } catch {
      return null
    }
  } else {
    try {
      path = decodeURIComponent(path)
    } catch {
      return null
    }
  }
  path = path.replace(/\\/g, '/')
  const root = projectFolder.replace(/\\/g, '/').replace(/\/+$/, '') || '/'
  if (path.startsWith('/')) {
    if (root === '/') {
      path = path.slice(1)
    } else if (path.startsWith(`${root}/`)) {
      path = path.slice(root.length + 1)
    } else {
      return null
    }
  }

  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
      continue
    }
    if (/[\u0000-\u001f\u007f]/.test(part)) return null
    parts.push(part)
  }
  return parts.length ? parts.join('/') : null
}

export function parseTerminalFileLinks(
  line: string,
  projectFolder: string
): ParsedTerminalFileLink[] {
  FILE_REFERENCE_PATTERN.lastIndex = 0
  return [...line.matchAll(FILE_REFERENCE_PATTERN)].flatMap(
    (match): ParsedTerminalFileLink[] => {
      const rawPath = match[2]
      if (!rawPath || !looksLikeFilePath(rawPath)) return []
      const path = normalizeTerminalFilePath(rawPath, projectFolder)
      if (!path) return []
      const prefixLength = match[1]?.length ?? 0
      const text = match[0].slice(prefixLength)
      return [
        {
          startIndex: (match.index ?? 0) + prefixLength,
          text,
          target: {
            path,
            line:
              positiveInteger(match[3]) ??
              positiveInteger(match[5]) ??
              positiveInteger(match[7]),
            column:
              positiveInteger(match[4]) ??
              positiveInteger(match[6]) ??
              positiveInteger(match[8])
          }
        }
      ]
    }
  )
}

export function terminalFileLinkProvider(
  terminal: Terminal,
  projectFolder: string,
  onOpenFile: (target: TerminalFileTarget) => void
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active
        .getLine(bufferLineNumber - 1)
        ?.translateToString(true)
      if (!line) {
        callback(undefined)
        return
      }
      const links: ILink[] = parseTerminalFileLinks(line, projectFolder).map(
        (link) => ({
          text: link.text,
          range: {
            start: {
              x: link.startIndex + 1,
              y: bufferLineNumber
            },
            end: {
              x: link.startIndex + link.text.length,
              y: bufferLineNumber
            }
          },
          decorations: {
            pointerCursor: true,
            underline: true
          },
          activate() {
            onOpenFile(link.target)
          }
        })
      )
      callback(links.length ? links : undefined)
    }
  }
}
