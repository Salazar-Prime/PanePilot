import { describe, expect, it } from 'vitest'
import {
  codexComposerIsReady,
  codexRenameInput,
  createCodexSessionName
} from '../src/main/codex-session-name'

describe('Codex session naming', () => {
  it('creates a stable, shell-safe name from the terminal name and unique token', () => {
    expect(createCodexSessionName('Fix: Remote API!', 'A1B2-C3D4-E5F6')).toBe(
      'panepilot-fix-remote-api-a1b2c3d4e5f6'
    )
  })

  it('uses safe fallbacks and bounds long names', () => {
    const name = createCodexSessionName('🎉', '---')
    expect(name).toBe('panepilot-codex-session')
    expect(
      createCodexSessionName('A very long terminal name '.repeat(10), '1234567890abcdef')
        .length
    ).toBeLessThanOrEqual(63)
  })

  it('waits for the Codex composer before sending the rename command', () => {
    expect(codexComposerIsReady(['Working (12s • esc to interrupt)'])).toBe(false)
    expect(codexComposerIsReady(['  › Ask Codex to do something'])).toBe(true)
    expect(codexRenameInput('panepilot-codex-1234')).toBe(
      '/rename panepilot-codex-1234\r'
    )
  })
})
