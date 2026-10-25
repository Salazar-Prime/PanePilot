import { describe, expect, it, vi } from 'vitest'
import type { Project, ProjectAction, TerminalSession } from '../src/shared/types'
import { actionRunActive, lastProjectAction, lastProjectActionCommand } from '../src/renderer/src/lib/lastProjectAction'
import { filterCommands, runPaletteCommand } from '../src/renderer/src/lib/commandPalette'
import { runProjectAction } from '../src/renderer/src/lib/actionRuns'

const session = (id: string, createdAt: string, state = 'completed') => ({
  id, projectId: 'p', kind: 'action', createdAt, state, archived: false
}) as TerminalSession
const action = (id: string, lastSessionId: string | null) => ({
  id, projectId: 'p', name: id, command: `npm run ${id}`, lastSessionId, updatedAt: '2099-01-01'
}) as ProjectAction
const project = () => ({
  id: 'p', name: 'Project', archived: false,
  actions: [action('build', 'build-run'), action('tests', 'test-run'), action('never-run', null)],
  sessions: [session('build-run', '2026-10-20'), session('test-run', '2026-10-24')]
}) as Project

describe('last action quick run', () => {
  it('uses the latest run creation time, not definition edits, output updates, or card order', () => {
    const p = project()
    p.actions.reverse()
    p.actions.find((item) => item.id === 'build')!.updatedAt = '2099-01-01'
    p.sessions[0].updatedAt = '2099-01-01'
    expect(lastProjectAction(p)?.action.id).toBe('tests')
  })
  it('skips missing, mismatched, archived, unrelated and invalid-date sessions', () => {
    for (const patch of [{ kind: 'terminal' }, { projectId: 'other' }, { archived: true }, { createdAt: 'bad' }]) {
      const p = project()
      Object.assign(p.sessions[1], patch)
      expect(lastProjectAction(p)?.action.id).toBe('build')
    }
    const p = project()
    p.actions[1].projectId = 'other'
    expect(lastProjectAction(p)?.action.id).toBe('build')
    expect(lastProjectAction({ ...p, archived: true })).toBeNull()
    expect(lastProjectAction({ ...p, sessions: [] })).toBeNull()
    expect(lastProjectAction(null)).toBeNull()
  })
  it('falls back to the last remaining run after deleting an action, never to an unrun definition', () => {
    const p = project()
    p.actions = p.actions.filter((item) => item.id !== 'tests')
    expect(lastProjectAction(p)?.action.id).toBe('build')
    p.actions = [action('never-run', null)]
    expect(lastProjectAction(p)).toBeNull()
  })
  it('uses the same already-running guard as the backend', () => {
    for (const state of ['running', 'idle', 'needs-input', 'response-ready', 'needs-attention']) {
      expect(actionRunActive(session('x', '2026-10-24', state))).toBe(true)
    }
    expect(actionRunActive(session('x', '2026-10-24', 'completed'))).toBe(false)
    expect(actionRunActive(session('x', '2026-10-24', 'error'))).toBe(false)
  })
  it('offers a searchable project-targeted command without executing during discovery', async () => {
    const p = project(), run = vi.fn().mockResolvedValue(undefined)
    const command = lastProjectActionCommand(p, false, run)!
    expect(filterCommands([command], 'run last project tests')).toEqual([command])
    expect(run).not.toHaveBeenCalled()
    p.id = 'changed-after-palette-open'
    await command.action()
    expect(run).toHaveBeenCalledExactlyOnceWith('p', 'tests')
  })
  it('omits the palette shortcut when there is no valid run or it is already active/pending', () => {
    const p = project(), run = vi.fn()
    expect(lastProjectActionCommand(p, true, run)).toBeNull()
    p.sessions[1].state = 'running'
    expect(lastProjectActionCommand(p, false, run)).toBeNull()
    expect(lastProjectActionCommand(null, false, run)).toBeNull()
    expect(lastProjectActionCommand({ ...p, sessions: [] }, false, run)).toBeNull()
  })
  it('reports palette IPC errors through its existing error path', async () => {
    const error = Error('SSH unavailable'), report = vi.fn()
    const command = lastProjectActionCommand(project(), false, vi.fn().mockRejectedValue(error))!
    await runPaletteCommand(command, report)
    expect(report).toHaveBeenCalledWith(error)
  })
  it('coalesces concurrent runs and waits for refresh without duplicate IPC', async () => {
    let resolve!: (value: TerminalSession) => void
    const run = vi.fn(() => new Promise<TerminalSession>((done) => { resolve = done }))
    vi.stubGlobal('window', { projectConsole: { actions: { run } } })
    try {
      const refresh = vi.fn().mockResolvedValue(undefined)
      const first = runProjectAction('unit-action', refresh)
      const second = runProjectAction('unit-action', refresh)
      expect(first).toBe(second)
      await Promise.resolve()
      expect(run).toHaveBeenCalledExactlyOnceWith('unit-action')
      resolve(session('new', '2026-10-24', 'running'))
      await first
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally { vi.unstubAllGlobals() }
  })
  it('cleans pending requests on failure and never retries a launched command after refresh failure', async () => {
    const run = vi.fn().mockRejectedValueOnce(Error('Offline')).mockResolvedValue(session('new', '2026-10-24'))
    vi.stubGlobal('window', { projectConsole: { actions: { run } } })
    try {
      await expect(runProjectAction('failure-test')).rejects.toThrow('Offline')
      await expect(runProjectAction('failure-test', async () => { throw Error('Read failed') })).rejects.toThrow('action started')
      expect(run).toHaveBeenCalledTimes(2)
    } finally { vi.unstubAllGlobals() }
  })
})
