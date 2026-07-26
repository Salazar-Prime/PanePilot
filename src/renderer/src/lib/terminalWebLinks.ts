import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

interface ParsedTerminalWebLink {
  startIndex: number
  text: string
  url: string
}

const WEB_URL_PATTERN = /https?:\/\/[^\s\u0000-\u001f\u007f<>"'`]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?]/
const CLOSING_PAIRS: Record<string, string> = {
  ')': '(',
  ']': '[',
  '}': '{'
}

function trimUrlCandidate(candidate: string): string {
  let end = candidate.length
  while (end > 0) {
    const last = candidate[end - 1]
    if (TRAILING_PUNCTUATION.test(last)) {
      end -= 1
      continue
    }
    const opening = CLOSING_PAIRS[last]
    if (opening) {
      const value = candidate.slice(0, end)
      const openings = [...value].filter((character) => character === opening).length
      const closings = [...value].filter((character) => character === last).length
      if (closings > openings) {
        end -= 1
        continue
      }
    }
    break
  }
  return candidate.slice(0, end)
}

export function parseTerminalWebLinks(line: string): ParsedTerminalWebLink[] {
  WEB_URL_PATTERN.lastIndex = 0
  return [...line.matchAll(WEB_URL_PATTERN)].flatMap(
    (match): ParsedTerminalWebLink[] => {
      const text = trimUrlCandidate(match[0])
      if (!text) return []
      try {
        const parsed = new URL(text)
        if (!['http:', 'https:'].includes(parsed.protocol)) return []
      } catch {
        return []
      }
      return [
        {
          startIndex: match.index ?? 0,
          text,
          url: text
        }
      ]
    }
  )
}

export function terminalWebLinkProvider(
  terminal: Terminal,
  onOpenUrl: (url: string) => void
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
      const links: ILink[] = parseTerminalWebLinks(line).map((link) => ({
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
          onOpenUrl(link.url)
        }
      }))
      callback(links.length ? links : undefined)
    }
  }
}
