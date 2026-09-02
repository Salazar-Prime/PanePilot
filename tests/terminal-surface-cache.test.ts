import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Project, TerminalSession } from '../src/shared/types'
import {
  MAX_WARM_TERMINALS_PER_PANE,
  reconcileTerminalSurfaces,
  retainTerminalSurface,
  type TerminalSurfaceCacheEntry
} from '../src/renderer/src/lib/terminalSurfaceCache'

function session(id: string, projectId = 'project'): TerminalSession {
  return {
    id,
    projectId,
    kind: 'terminal',
    name: id,
    profile: 'shell',
    providerSessionId: null,
    providerSessionName: null,
    customCommand: null,
    backend: 'tmux',
    tmuxName: id,
    state: 'idle',
    dangerousMode: false,
    archived: false,
    pinned: false,
    flagged: false,
    output: '',
    latexChat: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

function project(id: string, sessions: TerminalSession[]): Project {
  return {
    id,
    type: 'terminal',
    name: id,
    icon: null,
    connectionId: 'local',
    folder: `/tmp/${id}`,
    repositoryUrl: null,
    latex: null,
    state: 'idle',
    archived: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    sessions,
    actions: [],
    activities: []
  }
}

function view(id: string): TerminalSurfaceCacheEntry {
  return {
    projectId: 'project',
    projectFolder: '/tmp/project',
    session: session(id)
  }
}

describe('pane terminal surface cache', () => {
  it('keeps only the four most recently visited terminals per pane', () => {
    let views: TerminalSurfaceCacheEntry[] = []
    for (const id of ['one', 'two', 'three', 'four', 'five']) {
      views = retainTerminalSurface(views, view(id))
    }
    expect(MAX_WARM_TERMINALS_PER_PANE).toBe(4)
    expect(views.map((entry) => entry.session.id)).toEqual([
      'two',
      'three',
      'four',
      'five'
    ])

    views = retainTerminalSurface(views, view('three'))
    expect(views.map((entry) => entry.session.id)).toEqual([
      'two',
      'four',
      'five',
      'three'
    ])
  })

  it('updates metadata and evicts renderer views for removed sessions', () => {
    const current = [view('one'), view('two')]
    const updatedTwo = { ...session('two'), name: 'renamed' }
    const next = reconcileTerminalSurfaces(
      current,
      [project('project', [updatedTwo])]
    )

    expect(next).toHaveLength(1)
    expect(next[0]?.session).toBe(updatedTwo)
  })

  it('keeps hidden terminals non-writable and avoids renderer detach calls', () => {
    const managedSource = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'ManagedTerminal.tsx'
      ),
      'utf8'
    )
    const stackSource = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'PaneWorkspaceStack.tsx'
      ),
      'utf8'
    )

    expect(managedSource).toContain('activeRef.current &&')
    expect(managedSource).toContain('if (!activeRef.current) return')
    expect(managedSource).not.toContain('terminals.detach')
    expect(managedSource).not.toContain('terminals.stop')
    expect(stackSource).toContain('const NonTerminalWorkspace =')
    expect(stackSource).toContain('terminalProjects.map')
  })
})
