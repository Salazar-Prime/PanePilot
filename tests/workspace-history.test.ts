import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, TerminalSession } from '../src/shared/types'
import {
  WORKSPACE_HISTORY_STORAGE_KEY,
  WORKSPACE_HISTORY_LIMIT,
  consumeWorkspaceTabRequest,
  createWorkspaceDestination,
  loadWorkspaceHistory,
  nextWorkspaceSwitcherIndex,
  nextWorkspaceSwitcherMode,
  projectCapabilityDestinations,
  projectTerminalDestinations,
  recentWorkspaceDestinations,
  recordWorkspaceDestination,
  removeWorkspaceDestination,
  workspaceHistoryRemovalTarget,
  saveWorkspaceHistory,
  workspaceSwitcherArrowAction,
  workspaceSwitcherDestinations,
  workspaceTerminalIndicator,
  workspaceTabRequestFor
} from '../src/renderer/src/lib/workspaceHistory'

const session: TerminalSession = {
  id: 'session-1',
  projectId: 'project-1',
  kind: 'terminal',
  name: 'Codex release',
  profile: 'codex',
  providerSessionId: null,
  providerSessionName: null,
  customCommand: null,
  backend: 'tmux',
  tmuxName: 'Codex release',
  state: 'idle',
  dangerousMode: false,
  archived: false,
  pinned: false,
  flagged: false,
  output: '',
  latexChat: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z'
}

const project: Project = {
  id: 'project-1',
  type: 'terminal',
  name: 'PanePilot',
  icon: null,
  connectionId: 'local',
  folder: '/project',
  repositoryUrl: null,
  latex: null,
  state: 'idle',
  archived: false,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  sessions: [session],
  actions: [],
  activities: []
}

describe('recent workspace history', () => {
  it('moves revisited destinations to the front without duplicates', () => {
    const notes = createWorkspaceDestination({ project, tab: 'notes' })
    const files = createWorkspaceDestination({ project, tab: 'files' })
    let history = recordWorkspaceDestination([], notes)
    history = recordWorkspaceDestination(history, files)
    history = recordWorkspaceDestination(history, notes)

    expect(history.map((item) => item.key)).toEqual([notes.key, files.key])
    expect(
      recentWorkspaceDestinations(history, notes.key, [project])
    ).toEqual([expect.objectContaining({ key: files.key })])
  })

  it('retains the last twenty unique destinations in access order', () => {
    const destinations = Array.from({ length: 24 }, (_, index) =>
      createWorkspaceDestination({
        project: { ...project, id: `project-${index}` },
        tab: 'files',
        visitedAt: index
      })
    )
    let history = destinations.reduce(recordWorkspaceDestination, [])

    expect(WORKSPACE_HISTORY_LIMIT).toBe(20)
    expect(history).toHaveLength(20)
    expect(history.map((item) => item.projectId)).toEqual(
      destinations
        .slice(4)
        .reverse()
        .map((item) => item.projectId)
    )

    history = recordWorkspaceDestination(history, destinations[10])
    expect(history[0].key).toBe(destinations[10].key)
    expect(new Set(history.map((item) => item.key)).size).toBe(20)
  })

  it('shows at most seven valid destinations and refreshes their labels', () => {
    let history = ['terminal', 'actions', 'qna', 'notes', 'files', 'chats', 'activity']
      .map((tab, index) =>
        createWorkspaceDestination({
          project,
          tab: tab as Parameters<typeof createWorkspaceDestination>[0]['tab'],
          visitedAt: index
        })
      )
      .reduce(recordWorkspaceDestination, [])
    history = [
      createWorkspaceDestination({
        project,
        tab: 'terminal',
        sessionId: 'missing-session',
        sessionName: 'Missing'
      }),
      ...history
    ]
    const renamedProject = { ...project, name: 'PanePilot renamed' }

    const recent = recentWorkspaceDestinations(
      history,
      null,
      [renamedProject]
    )
    expect(recent).toHaveLength(7)
    expect(recent.every((item) => item.projectName === 'PanePilot renamed')).toBe(
      true
    )
    expect(recent.some((item) => item.sessionId === 'missing-session')).toBe(
      false
    )
  })

  it('pins the current destination above seven recent items', () => {
    const current = createWorkspaceDestination({ project, tab: 'notes' })
    const projects = Array.from({ length: 7 }, (_, index) => ({
      ...project,
      id: `recent-${index}`,
      name: `Recent ${index}`
    }))
    const history = [
      current,
      ...projects.map((candidate, index) =>
        createWorkspaceDestination({
          project: candidate,
          tab: 'files',
          visitedAt: 100 - index
        })
      )
    ]

    const destinations = workspaceSwitcherDestinations(
      history,
      current,
      [project, ...projects]
    )
    expect(destinations).toHaveLength(8)
    expect(destinations[0].key).toBe(current.key)
    expect(destinations.slice(1)).toHaveLength(7)
  })

  it('removes one history destination without disturbing access order', () => {
    const notes = createWorkspaceDestination({ project, tab: 'notes' })
    const files = createWorkspaceDestination({ project, tab: 'files' })
    const chats = createWorkspaceDestination({ project, tab: 'chats' })

    expect(
      removeWorkspaceDestination([notes, files, chats], files.key).map(
        (item) => item.key
      )
    ).toEqual([notes.key, chats.key])
  })

  it('drops destinations whose project or session was archived', () => {
    const terminal = createWorkspaceDestination({
      project,
      tab: 'terminal',
      sessionId: session.id,
      sessionName: session.name
    })
    expect(recentWorkspaceDestinations([terminal], null, [project])).toHaveLength(
      1
    )
    expect(
      recentWorkspaceDestinations(
        [terminal],
        null,
        [{ ...project, sessions: [{ ...session, archived: true }] }]
      )
    ).toEqual([])
    expect(
      recentWorkspaceDestinations(
        [terminal],
        null,
        [{ ...project, archived: true }]
      )
    ).toEqual([])
  })

  it('persists safely and ignores malformed client-local history', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
    const notes = createWorkspaceDestination({ project, tab: 'notes' })
    const files = createWorkspaceDestination({ project, tab: 'files' })

    saveWorkspaceHistory(storage, [notes])
    expect(loadWorkspaceHistory(storage)).toEqual([notes])
    saveWorkspaceHistory(
      storage,
      Array.from({ length: 24 }, (_, index) => ({
        ...notes,
        key: `notes-${index}`
      }))
    )
    expect(
      JSON.parse(values.get(WORKSPACE_HISTORY_STORAGE_KEY) ?? '[]')
    ).toHaveLength(20)
    saveWorkspaceHistory(storage, [notes, notes, files])
    expect(loadWorkspaceHistory(storage).map((item) => item.key)).toEqual([
      notes.key,
      files.key
    ])
    values.set(WORKSPACE_HISTORY_STORAGE_KEY, '{bad json')
    expect(loadWorkspaceHistory(storage)).toEqual([])
  })

  it('targets and consumes a tab request for exactly one pane', () => {
    const request = {
      id: 8,
      projectId: project.id,
      pane: 'b' as const,
      tab: 'files' as const
    }
    expect(workspaceTabRequestFor(request, project.id, 'a')).toBeNull()
    expect(workspaceTabRequestFor(request, project.id, 'b')).toBe(request)
    expect(consumeWorkspaceTabRequest(request, 7)).toBe(request)
    expect(consumeWorkspaceTabRequest(request, 8)).toBeNull()
  })

  it('cycles the glass highlight in both directions and wraps', () => {
    expect(nextWorkspaceSwitcherIndex(0, 7)).toBe(1)
    expect(nextWorkspaceSwitcherIndex(6, 7)).toBe(0)
    expect(nextWorkspaceSwitcherIndex(0, 7, -1)).toBe(6)
    expect(nextWorkspaceSwitcherIndex(0, 0)).toBe(0)
  })

  it('reserves horizontal primary arrows only while the switcher is open', () => {
    const shortcut = (code: string) => ({
      code,
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    })

    expect(workspaceSwitcherArrowAction(shortcut('ArrowLeft'), false)).toBeNull()
    expect(workspaceSwitcherArrowAction(shortcut('ArrowRight'), false)).toBeNull()
    expect(workspaceSwitcherArrowAction(shortcut('ArrowLeft'), true)).toBe(
      'previous-view'
    )
    expect(workspaceSwitcherArrowAction(shortcut('ArrowRight'), true)).toBe(
      'next-view'
    )
    expect(workspaceSwitcherArrowAction(shortcut('ArrowUp'), false)).toBe(
      'previous'
    )
    expect(workspaceSwitcherArrowAction(shortcut('ArrowDown'), false)).toBe(
      'next'
    )
  })

  it('cycles through all three switcher views in either direction', () => {
    expect(nextWorkspaceSwitcherMode('recent', 1)).toBe('capabilities')
    expect(nextWorkspaceSwitcherMode('capabilities', 1)).toBe('terminals')
    expect(nextWorkspaceSwitcherMode('terminals', 1)).toBe('recent')
    expect(nextWorkspaceSwitcherMode('recent', -1)).toBe('terminals')
    expect(nextWorkspaceSwitcherMode('terminals', -1)).toBe('capabilities')
    expect(nextWorkspaceSwitcherMode('capabilities', -1)).toBe('recent')
  })

  it('hydrates the project icon and live status for terminal destinations', () => {
    const runningProject = {
      ...project,
      icon: '🚀',
      sessions: [{ ...session, state: 'running' as const, flagged: true }]
    }
    const terminal = createWorkspaceDestination({
      project: runningProject,
      tab: 'terminal',
      sessionId: session.id,
      sessionName: session.name
    })

    expect(terminal.projectIcon).toBe('🚀')
    expect(workspaceTerminalIndicator(terminal)).toBe('working')
    expect(terminal.terminalFlagged).toBe(true)

    const [attention] = recentWorkspaceDestinations(
      [terminal],
      null,
      [
        {
          ...runningProject,
          icon: '🛰️',
          sessions: [{ ...session, state: 'needs-input' as const }]
        }
      ]
    )
    expect(attention.projectIcon).toBe('🛰️')
    expect(workspaceTerminalIndicator(attention)).toBe('attention')
  })

  it('never puts terminal lifecycle status on capability sub-icons', () => {
    const notes = createWorkspaceDestination({
      project: {
        ...project,
        sessions: [{ ...session, state: 'running' as const }]
      },
      tab: 'notes',
      sessionId: session.id,
      sessionName: session.name
    })

    expect(notes.terminalState).toBeNull()
    expect(notes.terminalFlagged).toBe(false)
    expect(workspaceTerminalIndicator(notes)).toBeNull()
  })

  it('builds project terminal and capability drill-down destinations', () => {
    const secondSession = {
      ...session,
      id: 'session-2',
      name: 'Shell',
      profile: 'shell' as const
    }
    const populatedProject = {
      ...project,
      sessions: [session, secondSession]
    }

    expect(
      projectTerminalDestinations(populatedProject).map((item) => item.sessionName)
    ).toEqual(['Codex release', 'Shell'])
    expect(
      projectCapabilityDestinations(project).map((item) => item.tab)
    ).toEqual([
      'actions',
      'qna',
      'notes',
      'files',
      'chats',
      'activity'
    ])
  })

  it('sorts each project terminal by recent history, with access history as fallback', () => {
    const sessions = [
      { ...session, id: 'older', name: 'Older', pinned: true },
      { ...session, id: 'first', name: 'First' },
      { ...session, id: 'second', name: 'Second' },
      { ...session, id: 'fallback', name: 'Fallback' }
    ]
    const owner = { ...project, sessions }
    const history = ['second', 'first'].map((sessionId) =>
      createWorkspaceDestination({ project: owner, tab: 'terminal', sessionId })
    )
    const destinations = projectTerminalDestinations(owner, history, { fallback: 3, older: 1 })
    expect(destinations.map((item) => item.sessionId)).toEqual([
      'second', 'first', 'fallback', 'older'
    ])
    // Two entries from the same project retain separate animation identities.
    expect(destinations.slice(0, 2).map((item) => item.key)).toEqual(
      history.map((item) => item.key)
    )
    expect(owner.sessions.map((item) => item.id)).toEqual(['older', 'first', 'second', 'fallback'])
  })

  it('keeps the transient switcher keyboard-only', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'WorkspaceSwitcherOverlay.tsx'
      ),
      'utf8'
    )
    const styles = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'src', 'workspace-switcher.css'),
      'utf8'
    )

    expect(component).not.toContain('onClick')
    expect(component).not.toContain('onSelect')
    expect(styles).toContain('user-select: none')
  })

  it('temporarily yields Electron menu accelerators to history', () => {
    const app = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'src', 'components', 'App.tsx'),
      'utf8'
    )
    const preload = readFileSync(
      join(process.cwd(), 'src', 'preload', 'index.ts'),
      'utf8'
    )
    const main = readFileSync(
      join(process.cwd(), 'src', 'main', 'index.ts'),
      'utf8'
    )

    expect(app).toContain('workspaceHistory?.setSwitcherOpen(willOpen)')
    expect(preload).toContain("workspace-history:set-switcher-open")
    expect(main).toContain('setIgnoreMenuShortcuts(open === true)')
    expect(main).toContain('setIgnoreMenuShortcuts(false)')
  })

  it('removes the keyboard selection or hovered history row while protecting Current', () => {
    const notes = createWorkspaceDestination({ project, tab: 'notes' })
    const files = createWorkspaceDestination({ project, tab: 'files' })
    const chats = createWorkspaceDestination({ project, tab: 'chats' })
    const state = {
      mode: 'recent' as const,
      currentKey: notes.key,
      hoveredKey: null,
      selectedIndex: 1,
      destinations: [notes, files, chats]
    }
    expect(workspaceHistoryRemovalTarget(state)).toBe(files.key)
    expect(workspaceHistoryRemovalTarget({ ...state, hoveredKey: chats.key })).toBe(chats.key)
    expect(workspaceHistoryRemovalTarget({ ...state, hoveredKey: notes.key })).toBeNull()
    expect(workspaceHistoryRemovalTarget({ ...state, selectedIndex: 0 })).toBeNull()
    expect(workspaceHistoryRemovalTarget({ ...state, mode: 'terminals' })).toBeNull()
    expect(workspaceHistoryRemovalTarget({ ...state, hoveredKey: 'missing' })).toBeNull()
  })
})
