import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceVisitDwell } from '../src/renderer/src/lib/workspaceVisitDwell'
import { recordWorkspaceDestination, type WorkspaceDestination } from '../src/renderer/src/lib/workspaceHistory'

function destination(key: string): WorkspaceDestination {
  return { key, projectId: 'project', projectName: 'Paper', projectType: 'terminal',
    tab: 'notes', tabLabel: 'Notes', sessionId: null, sessionName: null, visitedAt: 0 }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers() })

describe('workspace history dwell threshold', () => {
  it('records only after five uninterrupted seconds', () => {
    const record = vi.fn()
    const tracker = new WorkspaceVisitDwell(record)
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(4_999)
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(record).toHaveBeenCalledExactlyOnceWith({ ...destination('notes'), visitedAt: 15_000 })
  })

  it('skips tabs passed through while navigating', () => {
    const record = vi.fn()
    const tracker = new WorkspaceVisitDwell(record)
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(3_000)
    tracker.visit(destination('files'))
    vi.advanceTimersByTime(2_000)
    tracker.visit(destination('terminal'))
    vi.advanceTimersByTime(5_000)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0].key).toBe('terminal')
  })

  it('does not accumulate time across separate short visits', () => {
    const record = vi.fn()
    const tracker = new WorkspaceVisitDwell(record)
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(3_000)
    tracker.visit(destination('files'))
    vi.advanceTimersByTime(1_000)
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(3_000)
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2_000)
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('keeps the timer running through metadata updates and records the latest label', () => {
    const record = vi.fn()
    const tracker = new WorkspaceVisitDwell(record)
    tracker.visit(destination('terminal'))
    vi.advanceTimersByTime(4_000)
    tracker.visit({ ...destination('terminal'), sessionName: 'Renamed terminal' })
    vi.advanceTimersByTime(1_000)
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0].sessionName).toBe('Renamed terminal')
    tracker.visit(destination('terminal'))
    vi.advanceTimersByTime(60_000)
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('does not promote or remove an existing history item during a brief revisit', () => {
    let history = [destination('files'), destination('notes')]
    const tracker = new WorkspaceVisitDwell((item) => { history = recordWorkspaceDestination(history, item) })
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(4_000)
    tracker.visit(null)
    vi.advanceTimersByTime(6_000)
    expect(history.map((item) => item.key)).toEqual(['files', 'notes'])
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(5_000)
    expect(history.map((item) => item.key)).toEqual(['notes', 'files'])
  })

  it('cancels without flushing when focus is lost, the workspace disappears, or the app unmounts', () => {
    const record = vi.fn()
    const tracker = new WorkspaceVisitDwell(record)
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(4_999)
    tracker.reset()
    vi.advanceTimersByTime(10_000)
    expect(record).not.toHaveBeenCalled()
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(4_999)
    expect(record).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('leaves an already qualified visit in history when departing', () => {
    const record = vi.fn()
    const tracker = new WorkspaceVisitDwell(record)
    tracker.visit(destination('notes'))
    vi.advanceTimersByTime(5_000)
    tracker.visit(destination('files'))
    vi.advanceTimersByTime(100)
    tracker.reset()
    expect(record).toHaveBeenCalledTimes(1)
    expect(record.mock.calls[0][0].key).toBe('notes')
  })

  it('routes focused-pane reports through the timer while keeping Current immediate', () => {
    const app = readFileSync('src/renderer/src/components/App.tsx', 'utf8')
    expect(app).toContain('paneDestinationsRef.current[pane] = destination')
    expect(app).toContain('if (focusedPaneRef.current === pane) trackCurrentWorkspaceVisit()')
    expect(app).toContain('destination?.projectId === context.projectId')
    expect(app).toContain('destination.sessionId === context.sessionId')
    expect(app).toContain("window.addEventListener('blur', cancel)")
    const start = app.indexOf('  function activateWorkspaceDestination(')
    const activation = app.slice(start, app.indexOf('  async function reconnectSession(', start))
    expect(activation).not.toContain('storeWorkspaceVisit(')
    expect(activation).not.toContain('saveWorkspaceHistory(')
    expect(activation).toContain('paneDestinationsRef.current[pane] = destination')
  })
})
