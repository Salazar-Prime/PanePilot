import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  terminalLinkRange,
  terminalLogicalLine
} from '../src/renderer/src/lib/terminalLinkLines'

describe('terminal wrapped link lines', () => {
  it('reconstructs a logical line from wrapped physical rows', () => {
    const rows = [
      {
        isWrapped: false,
        translateToString: (trim: boolean) =>
          trim ? 'Files: exp2/jobs/very' : 'Files: exp2/jobs/very'
      },
      {
        isWrapped: true,
        translateToString: () => '/long/folder'
      },
      {
        isWrapped: false,
        translateToString: () => 'unrelated'
      }
    ]
    const terminal = {
      buffer: {
        active: {
          length: rows.length,
          getLine(index: number) {
            return rows[index]
          }
        }
      }
    } as unknown as Terminal

    expect(terminalLogicalLine(terminal, 2)).toEqual({
      text: 'Files: exp2/jobs/very/long/folder',
      startLine: 1
    })
  })

  it('maps a link across terminal rows', () => {
    expect(terminalLinkRange(8, 24, 4, 20)).toEqual({
      start: { x: 9, y: 4 },
      end: { x: 12, y: 5 }
    })
  })
})
