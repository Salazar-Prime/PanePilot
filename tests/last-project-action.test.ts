import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectAction, TerminalSession } from '../src/shared/types'
import { actionRunActive, lastProjectAction } from '../src/renderer/src/lib/lastProjectAction'
import { runProjectAction } from '../src/renderer/src/lib/actionRuns'

function action(id: string, sessionId: string | null = null): ProjectAction {
  return { id, projectId: 'p', name: id, command: `echo ${id}`, lastSessionId: sessionId,
    createdAt: '2026-01-01', updatedAt: '2026-10-29' }
}
function session(id: string, createdAt: string, state: TerminalSession['state'] = 'completed'): TerminalSession {
  return { id, projectId: 'p', kind: 'action', name: id, profile: 'custom', customCommand: null,
    providerSessionId: null, providerSessionName: null, backend: 'tmux', tmuxName: id, state,
    dangerousMode: false, archived: false, pinned: false, flagged: false, output: '', latexChat: null,
    createdAt, updatedAt: '2026-10-29' }
}
function project(actions: ProjectAction[], sessions: TerminalSession[] = []): Project {
  return { id: 'p', name: 'Project', type: 'terminal', connectionId: 'local', folder: '/fixture',
    icon: null, repositoryUrl: null, latex: null, archived: false, state: 'idle',
    createdAt: '2026-01-01', updatedAt: '2026-10-29', actions, sessions, activities: [] }
}
afterEach(() => vi.unstubAllGlobals())

describe('Actions hover target', () => {
  it('falls back to the first available action and honors the saved grid order', () => {
    const p = project([action('build'), action('tests')])
    expect(lastProjectAction(p)).toEqual({ action: p.actions[0], session: null, source: 'first' })
    expect(lastProjectAction(p, ['missing', 'tests', 'tests'])).toEqual({ action: p.actions[1], session: null, source: 'first' })
  })
  it('uses actual run creation time rather than definition edits, card order or output updates', () => {
    const old = session('old', '2026-10-01'), recent = session('recent', '2026-10-28')
    const p = project([action('build', 'old'), action('tests', 'recent')], [old, recent])
    old.updatedAt = '2027-01-01'; p.actions[0].updatedAt = '2027-01-01'
    expect(lastProjectAction(p, ['build'])?.action.id).toBe('tests')
    expect(lastProjectAction(p)?.source).toBe('last-run')
  })
  it('does not borrow sessions or definitions from another project or terminal capability', () => {
    const foreign = session('foreign', '2026-10-29'); foreign.projectId = 'other'
    const ordinary = session('ordinary', '2026-10-29'); ordinary.kind = 'terminal'
    const archived = session('archived', '2026-10-29'); archived.archived = true
    const invalid = session('invalid', 'not a date')
    const foreignAction = { ...action('foreign-action'), projectId: 'other' }
    const p = project([foreignAction, action('first', 'foreign'), action('second', 'ordinary'),
      action('third', 'archived'), action('fourth', 'invalid')], [foreign, ordinary, archived, invalid])
    expect(lastProjectAction(p)).toEqual({ action: p.actions[1], session: null, source: 'first' })
    expect(lastProjectAction(project([foreignAction]))).toBeNull()
  })
  it('falls back safely after deletion and handles empty/archived projects', () => {
    const p = project([action('only', 'missing')])
    expect(lastProjectAction(p)?.action.id).toBe('only')
    expect(lastProjectAction(project([]))).toBeNull()
    expect(lastProjectAction({ ...p, archived: true })).toBeNull()
    expect(lastProjectAction(null)).toBeNull()
  })
  it('uses the existing backend live-run guard for every lifecycle state', () => {
    expect(actionRunActive(null)).toBe(false)
    for (const state of ['completed', 'error'] as const) expect(actionRunActive(session('s', '', state))).toBe(false)
    for (const state of ['idle', 'running', 'needs-input', 'needs-attention', 'response-ready'] as const) {
      expect(actionRunActive(session('s', '', state))).toBe(true)
    }
  })
})

describe('shared action execution', () => {
  it('coalesces simultaneous popup and normal-panel requests without retargeting or retrying', async () => {
    let resolve!: (value: TerminalSession) => void
    const run = vi.fn(() => new Promise<TerminalSession>((done) => { resolve = done }))
    vi.stubGlobal('window', { projectConsole: { actions: { run } } })
    const refresh = vi.fn(async () => {})
    const first = runProjectAction('tests', refresh), second = runProjectAction('tests', refresh)
    expect(second).toBe(first)
    await Promise.resolve(); expect(run).toHaveBeenCalledExactlyOnceWith('tests')
    resolve(session('s', '2026-10-29', 'running'))
    await first; expect(refresh).toHaveBeenCalledTimes(1)
  })
  it('clears pending failures and only retries when explicitly asked', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('SSH offline')).mockResolvedValueOnce(session('s', '2026-10-29'))
    vi.stubGlobal('window', { projectConsole: { actions: { run } } })
    await expect(runProjectAction('build')).rejects.toThrow('SSH offline')
    expect(run).toHaveBeenCalledTimes(1)
    await runProjectAction('build'); expect(run).toHaveBeenCalledTimes(2)
  })
  it('reports a refresh failure as already started, with no automatic second execution', async () => {
    const run = vi.fn().mockResolvedValue(session('s', '2026-10-29', 'running'))
    vi.stubGlobal('window', { projectConsole: { actions: { run } } })
    await expect(runProjectAction('build', async () => { throw Error('refresh failed') })).rejects.toThrow('The action started')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
