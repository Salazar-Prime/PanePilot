import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clampLatexChatWidth,
  DEFAULT_LATEX_CHAT_WIDTH,
  loadLatexChatLayout,
  MAX_LATEX_CHAT_WIDTH,
  MIN_LATEX_CHAT_WIDTH,
  saveLatexChatLayout
} from '../src/renderer/src/lib/latexChatLayout'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('LaTeX writing chat layout', () => {
  it('stores independent visibility and width preferences per project', () => {
    const storage = new MemoryStorage()
    expect(loadLatexChatLayout('paper-a', storage)).toEqual({
      hidden: false,
      width: DEFAULT_LATEX_CHAT_WIDTH
    })

    saveLatexChatLayout('paper-a', { hidden: true, width: 430 }, storage)
    saveLatexChatLayout('paper-b', { hidden: false, width: 510 }, storage)

    expect(loadLatexChatLayout('paper-a', storage)).toEqual({
      hidden: true,
      width: 430
    })
    expect(loadLatexChatLayout('paper-b', storage)).toEqual({
      hidden: false,
      width: 510
    })
  })

  it('keeps the chat pane within useful global and workspace bounds', () => {
    expect(clampLatexChatWidth(20)).toBe(MIN_LATEX_CHAT_WIDTH)
    expect(clampLatexChatWidth(2_000)).toBe(MAX_LATEX_CHAT_WIDTH)
    expect(clampLatexChatWidth(600, 800)).toBe(464)
    expect(clampLatexChatWidth(Number.NaN)).toBe(DEFAULT_LATEX_CHAT_WIDTH)
  })

  it('mounts one writing chat beside both manuscript and PDF content', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'LatexProjectWorkspace.tsx'
      ),
      'utf8'
    )

    expect(source.match(/<LatexAgentPane/g)).toHaveLength(1)
    expect(source).toContain(
      "tab === 'manuscript' || tab === 'pdf' || pdfOpened"
    )
    expect(source).toContain('className="latex-agent-resizer"')
    expect(source).toContain('onHide={() =>')
  })

  it('keeps secondary chat actions out of the persistent toolbar', () => {
    const paneSource = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'LatexAgentPane.tsx'
      ),
      'utf8'
    )
    const workspaceSource = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'LatexProjectWorkspace.tsx'
      ),
      'utf8'
    )

    expect(paneSource).toContain('Writing chat options')
    expect(paneSource).toContain("menu.kind === 'sessions'")
    expect(paneSource).not.toContain('latex-chat-switcher')
    expect(paneSource).not.toContain('latex-force-reload-button')
    expect(workspaceSource).not.toContain('<Plus size={12} /> Chat')
  })
})
