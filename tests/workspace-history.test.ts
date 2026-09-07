import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Project, TerminalSession } from '../src/shared/types'
import {
  WORKSPACE_HISTORY_STORAGE_KEY,
  consumeWorkspaceTabRequest,
  createWorkspaceDestination,
  loadWorkspaceHistory,
  nextWorkspaceSwitcherIndex,
  projectCapabilityDestinations,
  projectTerminalDestinations,
  recentWorkspaceDestinations,
  recordWorkspaceDestination,
  saveWorkspaceHistory,
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

    saveWorkspaceHistory(storage, [notes])
    expect(loadWorkspaceHistory(storage)).toEqual([notes])
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
      'terminal',
      'actions',
      'qna',
      'notes',
      'files',
      'chats',
      'activity'
    ])
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

    expect(component).not.toContain('onMouseEnter')
    expect(component).not.toContain('onClick')
    expect(styles).toMatch(
      /\.workspace-switcher-overlay\s*\{[\s\S]*?pointer-events:\s*none;/
    )
  })
})
