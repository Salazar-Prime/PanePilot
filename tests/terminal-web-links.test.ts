import { describe, expect, it } from 'vitest'
import { parseTerminalWebLinks } from '../src/renderer/src/lib/terminalWebLinks'

describe('terminal web links', () => {
  it('recognizes HTTP and HTTPS URLs without trailing sentence punctuation', () => {
    expect(
      parseTerminalWebLinks(
        'Open https://example.com/docs?q=terminal, then http://127.0.0.1:3000.'
      ).map((link) => link.url)
    ).toEqual([
      'https://example.com/docs?q=terminal',
      'http://127.0.0.1:3000'
    ])
  })

  it('keeps balanced URL parentheses and removes surrounding punctuation', () => {
    expect(
      parseTerminalWebLinks(
        'See (https://en.wikipedia.org/wiki/Tmux_(software)).'
      )[0]?.url
    ).toBe('https://en.wikipedia.org/wiki/Tmux_(software)')
  })

  it('ignores non-web protocols', () => {
    expect(
      parseTerminalWebLinks(
        'Do not open javascript:alert(1) or file:///tmp/private.'
      )
    ).toEqual([])
  })

  it('opens common bare web hosts as HTTPS links', () => {
    expect(
      parseTerminalWebLinks(
        'Dashboard: wandb.ai/salprime/exp2-yolo26'
      )[0]
    ).toEqual(
      expect.objectContaining({
        text: 'wandb.ai/salprime/exp2-yolo26',
        url: 'https://wandb.ai/salprime/exp2-yolo26'
      })
    )
  })
})
