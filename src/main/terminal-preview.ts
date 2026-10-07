import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { TerminalPreviewSnapshot } from '../shared/types'

const run = promisify(execFile)
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
export function terminalPreviewArgs(name: string): string[] {
  const target = `=${name}:`
  return ['display-message', '-p', '-t', target, '#{pane_width} #{pane_height}',
    ';', 'capture-pane', '-p', '-e', '-t', target]
}

export function parseTerminalPreview(value: string): TerminalPreviewSnapshot {
  const newline = value.indexOf('\n')
  if (newline < 0) throw new Error('Terminal preview dimensions are unavailable.')
  const dimensions = /^(\d+) (\d+)\r?$/.exec(value.slice(0, newline))
  if (!dimensions) throw new Error('Terminal preview dimensions are unavailable.')
  const cols = Number(dimensions[1]), rows = Number(dimensions[2])
  if (cols < 1 || cols > 600 || rows < 1 || rows > 400) throw new Error('This terminal is too large to preview.')
  return { cols, rows, output: value.slice(newline + 1).replace(/\r?\n$/, ''), source: 'tmux' }
}

export async function captureTmuxPreview(path: string, name: string, alias?: string): Promise<TerminalPreviewSnapshot> {
  const args = terminalPreviewArgs(name)
  try {
    const result = alias
      ? await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', alias,
        `${quote(path)} ${args.map(quote).join(' ')}`], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024 })
      : await run(path, args, { encoding: 'utf8', timeout: 2_000, maxBuffer: 1024 * 1024 })
    return parseTerminalPreview(result.stdout)
  } catch {
    throw new Error('Screen preview unavailable. The terminal may be stopped or its host offline.')
  }
}

/** Bound SSH work even when the user rapidly browses several destinations. */
export class TerminalPreviewReads {
  private pending = new Map<string, Promise<TerminalPreviewSnapshot>>()
  private cached = new Map<string, { at: number; value: TerminalPreviewSnapshot }>()
  async read(id: string, capture: () => Promise<TerminalPreviewSnapshot>): Promise<TerminalPreviewSnapshot> {
    const cached = this.cached.get(id)
    if (cached && Date.now() - cached.at < 750) return cached.value
    const existing = this.pending.get(id)
    if (existing) return existing
    if (this.pending.size >= 2) throw new Error('Waiting for earlier preview reads to finish…')
    const request = capture().then((value) => {
      if (this.cached.size >= 12) this.cached.delete(this.cached.keys().next().value!)
      this.cached.set(id, { at: Date.now(), value })
      return value
    })
    this.pending.set(id, request)
    try { return await request } finally { this.pending.delete(id) }
  }
}
