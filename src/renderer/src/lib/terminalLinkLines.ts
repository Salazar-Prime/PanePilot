import type { IBufferRange, Terminal } from '@xterm/xterm'

export interface TerminalLogicalLine {
  text: string
  startLine: number
}

export function terminalLogicalLine(
  terminal: Terminal,
  bufferLineNumber: number
): TerminalLogicalLine | null {
  const buffer = terminal.buffer.active
  let startIndex = bufferLineNumber - 1
  if (!buffer.getLine(startIndex)) return null

  while (startIndex > 0 && buffer.getLine(startIndex)?.isWrapped) {
    startIndex -= 1
  }

  let lineIndex = startIndex
  let text = ''
  while (lineIndex < buffer.length) {
    const line = buffer.getLine(lineIndex)
    if (!line) break
    const nextWrapped = buffer.getLine(lineIndex + 1)?.isWrapped ?? false
    text += line.translateToString(!nextWrapped)
    if (!nextWrapped) break
    lineIndex += 1
  }

  return {
    text,
    startLine: startIndex + 1
  }
}

export function terminalLinkRange(
  startIndex: number,
  length: number,
  startLine: number,
  columns: number
): IBufferRange {
  const safeColumns = Math.max(1, columns)
  const endIndex = startIndex + Math.max(1, length) - 1
  return {
    start: {
      x: (startIndex % safeColumns) + 1,
      y: startLine + Math.floor(startIndex / safeColumns)
    },
    end: {
      x: (endIndex % safeColumns) + 1,
      y: startLine + Math.floor(endIndex / safeColumns)
    }
  }
}
