import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import {
  terminalLinkRange,
  terminalLogicalLine
} from './terminalLinkLines'

interface ParsedTerminalWebLink {
  startIndex: number
  text: string
  url: string
}

const BARE_WEB_HOST =
  String.raw`(?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:ai|app|com|dev|edu|gov|io|net|org)`
const WEB_URL_PATTERN = new RegExp(
  String.raw`https?:\/\/[^\s\u0000-\u001f\u007f<>"'\x60]+|${BARE_WEB_HOST}(?::\d+)?\/[^\s\u0000-\u001f\u007f<>"'\x60]*`,
  'gi'
)
const BARE_WEB_URL_PATTERN = new RegExp(
  String.raw`^${BARE_WEB_HOST}(?::\d+)?\/`,
  'i'
)
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
      const url = /^https?:\/\//i.test(text) ? text : `https://${text}`
      try {
        const parsed = new URL(url)
        if (!['http:', 'https:'].includes(parsed.protocol)) return []
      } catch {
        return []
      }
      return [
        {
          startIndex: match.index ?? 0,
          text,
          url
        }
      ]
    }
  )
}

export function isBareTerminalWebUrl(value: string): boolean {
  return BARE_WEB_URL_PATTERN.test(value)
}

export function terminalWebLinkProvider(
  terminal: Terminal,
  onOpenUrl: (url: string) => void
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const logicalLine = terminalLogicalLine(terminal, bufferLineNumber)
      if (!logicalLine?.text) {
        callback(undefined)
        return
      }
      const links: ILink[] = parseTerminalWebLinks(logicalLine.text).map((link) => ({
        text: link.text,
        range: terminalLinkRange(
          link.startIndex,
          link.text.length,
          logicalLine.startLine,
          terminal.cols
        ),
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
