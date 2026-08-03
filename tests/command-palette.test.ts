import { describe, expect, it } from 'vitest'
import { filterCommands } from '../src/renderer/src/lib/commandPalette'

const commands = [
  {
    id: 'settings',
    label: 'Project settings',
    detail: 'Research paper',
    keywords: ['repository', 'rename']
  },
  {
    id: 'drive',
    label: 'Google Drive connection',
    detail: 'Research paper',
    keywords: ['upload', 'cloud', 'gdrive']
  },
  {
    id: 'terminal',
    label: 'paper-agent',
    detail: 'Research paper · codex · running',
    keywords: ['terminal']
  }
]

describe('command palette filtering', () => {
  it('matches labels, details, and aliases while keeping label matches first', () => {
    expect(filterCommands(commands, 'drive').map(({ id }) => id)).toEqual(['drive'])
    expect(filterCommands(commands, 'research codex').map(({ id }) => id)).toEqual([
      'terminal'
    ])
    expect(filterCommands(commands, 'project').map(({ id }) => id)).toEqual([
      'settings'
    ])
    expect(filterCommands(commands, 'upload').map(({ id }) => id)).toEqual(['drive'])
  })
})
