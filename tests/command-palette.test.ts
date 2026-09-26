import { describe, expect, it, vi } from 'vitest'
import type { Project, TerminalSession } from '../src/shared/types'
import { commandPaletteSession, contextualCommands, filterCommands, runPaletteCommand } from '../src/renderer/src/lib/commandPalette'

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

describe('contextual palette commands', () => {
  const session = { id: 'chat', projectId: 'p', kind: 'terminal', profile: 'codex', archived: false } as TerminalSession
  const project = { id: 'p', sessions: [session], archived: false } as Project

  it('uses the visible session even before it connects', () => {
    expect(commandPaletteSession(project, { projectId: 'p', sessionId: 'chat' }, null)).toBe(session)
  })

  it('does not offer commands for a background terminal while viewing Files or Notes', () => {
    expect(commandPaletteSession(project, { projectId: 'p', sessionId: null }, session)).toBeNull()
  })

  it('does not borrow a session from the other split pane', () => {
    expect(commandPaletteSession({ ...project, id: 'other', sessions: [] }, { projectId: 'p', sessionId: 'chat' }, session)).toBeNull()
  })

  it('excludes archived sessions and hidden capability runners', () => {
    for (const hidden of [
      { ...session, archived: true },
      { ...session, kind: 'temporary-chat' as const },
      { ...session, kind: 'latex-chat' as const, latexChat: { purpose: 'inline-edit' } }
    ]) {
      expect(commandPaletteSession({ ...project, sessions: [hidden as TerminalSession] }, null, hidden as TerminalSession)).toBeNull()
    }
  })

  it('includes the selected LaTeX writing chat', () => {
    const writing = { ...session, kind: 'latex-chat', latexChat: { purpose: 'writing' } } as TerminalSession
    expect(commandPaletteSession({ ...project, sessions: [writing] }, { projectId: 'p', sessionId: writing.id }, null)).toBe(writing)
  })

  it('reuses menu actions and confirmation handlers without running them during search', async () => {
    const action = vi.fn()
    const commands = contextualCommands([
      { id: 'force-reload-agent', label: 'Force reload Codex chat', action },
      { id: 'transfer', label: 'Transfer', disabled: true, action },
      { id: 'delete', label: 'Delete terminal', danger: true, action }
    ], { id: 'session:chat', section: 'Current terminal', detail: 'Research · paper-chat' })
    expect(commands.map((item) => item.id)).toEqual(['session:chat:force-reload-agent', 'session:chat:delete'])
    expect(commands[1].danger).toBe(true)
    expect(filterCommands(commands, 'restart paper-chat')).toEqual([commands[0]])
    expect(action).not.toHaveBeenCalled()
    await runPaletteCommand(commands[0], vi.fn())
    expect(action).toHaveBeenCalledTimes(1)
  })

  it('distinguishes project rename from terminal rename', () => {
    const [command] = contextualCommands([{ id: 'rename', label: 'Rename', action: vi.fn() }],
      { id: 'project:p', section: 'Current project', detail: 'Research', project: true })
    expect(command.label).toBe('Rename project')
  })

  it('reports synchronous and asynchronous action errors', async () => {
    const error = new Error('Connection unavailable')
    const onError = vi.fn()
    await runPaletteCommand({ action: () => { throw error } }, onError)
    await runPaletteCommand({ action: async () => { throw error } }, onError)
    expect(onError).toHaveBeenNthCalledWith(1, error)
    expect(onError).toHaveBeenNthCalledWith(2, error)
  })
})
