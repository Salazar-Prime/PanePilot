import { describe, expect, it } from 'vitest'
import {
  normalizeTerminalFilePath,
  parseTerminalFileLinks
} from '../src/renderer/src/lib/terminalFileLinks'

describe('terminal file links', () => {
  const projectFolder = '/Users/example/project'

  it('parses relative paths with line and column suffixes', () => {
    expect(
      parseTerminalFileLinks(
        'Error at src/components/App.tsx:42:7',
        projectFolder
      )
    ).toEqual([
      expect.objectContaining({
        text: 'src/components/App.tsx:42:7',
        target: {
          path: 'src/components/App.tsx',
          line: 42,
          column: 7
        }
      })
    ])
  })

  it('normalizes absolute project paths and rejects outside paths', () => {
    expect(
      normalizeTerminalFilePath(
        '/Users/example/project/src/main.ts',
        projectFolder
      )
    ).toBe('src/main.ts')
    expect(
      normalizeTerminalFilePath('/Users/example/other/secret.txt', projectFolder)
    ).toBeNull()
    expect(
      normalizeTerminalFilePath('../other/secret.txt', projectFolder)
    ).toBeNull()
  })
})
