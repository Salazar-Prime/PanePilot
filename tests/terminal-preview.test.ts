import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parseTerminalPreview, terminalPreviewArgs, TerminalPreviewReads } from '../src/main/terminal-preview'
import { previewScale, workspacePreviewDestination } from '../src/renderer/src/lib/workspaceTerminalPreview'
import type { WorkspaceDestination } from '../src/renderer/src/lib/workspaceHistory'

const snapshot = { output: 'screen', cols: 80, rows: 24, source: 'tmux' as const }
const terminal = { projectId: 'p', sessionId: 's', tab: 'terminal', key: 's' } as WorkspaceDestination

describe('switcher preview selection', () => {
  it('uses only keyboard selection, including current and terminal drilldown', () => {
    const other = { ...terminal, sessionId: 'other' }
    expect(workspacePreviewDestination([terminal, other], 1, 'recent', null)).toBe(other)
    expect(workspacePreviewDestination([terminal], 0, 'terminals', null)).toBe(terminal)
  })
  it('hides previews for tools, missing sessions, empty lists, and removal transitions', () => {
    expect(workspacePreviewDestination([terminal], 0, 'capabilities', null)).toBeNull()
    expect(workspacePreviewDestination([{ ...terminal, tab: 'files' }], 0, 'recent', null)).toBeNull()
    expect(workspacePreviewDestination([{ ...terminal, sessionId: null }], 0, 'recent', null)).toBeNull()
    expect(workspacePreviewDestination([], 0, 'recent', null)).toBeNull()
    expect(workspacePreviewDestination([terminal], 0, 'recent', terminal.key)).toBeNull()
  })
  it('fits the whole screen without changing its aspect ratio or enlarging it', () => {
    expect(previewScale(500, 300, 1000, 400)).toBe(0.5)
    expect(previewScale(500, 300, 300, 600)).toBe(0.5)
    expect(previewScale(500, 300, 100, 100)).toBe(1)
  })
})

describe('read-only screen capture', () => {
  it('captures exact tmux target, ANSI colors and dimensions without history or attach', () => {
    const args = terminalPreviewArgs('example with spaces')
    expect(args).toEqual(['display-message', '-p', '-t', '=example with spaces:', '#{pane_width} #{pane_height}', ';', 'capture-pane', '-p', '-e', '-t', '=example with spaces:'])
    expect(args).not.toContain('-S')
    expect(parseTerminalPreview('80 24\n\x1b[32mHello\x1b[0m\n')).toEqual({ ...snapshot, output: '\x1b[32mHello\x1b[0m' })
  })
  it('rejects malformed and unbounded snapshots', () => {
    for (const value of ['error', '80 24', 'invalid\ntext', '0 24\n', '99999 99999\n']) {
      expect(() => parseTerminalPreview(value)).toThrow()
    }
  })
  it('coalesces identical requests, caches short-term, and bounds concurrent reads', async () => {
    const reads = new TerminalPreviewReads()
    let resolve!: (value: typeof snapshot) => void
    const capture = vi.fn(() => new Promise<typeof snapshot>((done) => { resolve = done }))
    const first = reads.read('a', capture)
    const duplicate = reads.read('a', capture)
    const second = reads.read('b', () => new Promise<typeof snapshot>(() => {}))
    void second
    await expect(reads.read('c', capture)).rejects.toThrow('Waiting')
    expect(capture).toHaveBeenCalledTimes(1)
    resolve(snapshot)
    expect(await first).toBe(snapshot)
    expect(await duplicate).toBe(snapshot)
    expect(await reads.read('a', capture)).toBe(snapshot)
    expect(capture).toHaveBeenCalledTimes(1)
  })
  it('releases capacity after failures', async () => {
    const reads = new TerminalPreviewReads()
    await expect(reads.read('a', async () => { throw new Error('offline') })).rejects.toThrow('offline')
    expect(await reads.read('a', async () => snapshot)).toBe(snapshot)
  })
  it('preview routing never attaches, resizes, acknowledges, or opens the terminal', () => {
    const renderer = readFileSync('src/renderer/src/components/WorkspaceTerminalPreview.tsx', 'utf8')
    for (const method of ['attach(', 'resize(', 'acknowledge(', 'write(']) expect(renderer).not.toContain(`terminals.${method}`)
    expect(renderer).toContain('if (!disposed)')
    expect(renderer).toContain('clearTimeout(timer)')
    expect(renderer).toContain('host.current.inert = true')
    const manager = readFileSync('src/main/terminal-manager.ts', 'utf8')
    const preview = manager.slice(manager.indexOf('  async preview('), manager.indexOf('  async captureBuffer('))
    expect(preview).not.toContain('this.attach(')
    expect(preview).not.toContain('this.changeState(')
    expect(preview).not.toContain('this.tmuxPathForConnection(')
    expect(preview).toContain('await resolveRemoteTmuxAsync(')
  })
  it.skipIf(spawnSync('tmux', ['-V']).status !== 0)('captures a real isolated tmux screen without changing dimensions or attaching clients', () => {
    const socket = `panepilot-preview-test-${randomUUID()}`
    const run = (args: string[]) => execFileSync('tmux', ['-L', socket, ...args], { encoding: 'utf8', timeout: 3000 })
    try {
      run(['-f', '/dev/null', 'new-session', '-d', '-s', 'preview', '-x', '90', '-y', '28'])
      const before = run(['display-message', '-p', '-t', '=preview:', '#{pane_width} #{pane_height} #{session_attached}'])
      const captured = parseTerminalPreview(run(terminalPreviewArgs('preview')))
      expect(captured.cols).toBe(90)
      expect(captured.rows).toBe(28)
      expect(run(['display-message', '-p', '-t', '=preview:', '#{pane_width} #{pane_height} #{session_attached}'])).toBe(before)
    } finally { run(['kill-server']) }
  })
})
