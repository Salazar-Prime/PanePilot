import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TerminalLauncher } from '../src/renderer/src/components/TerminalLauncher'

describe('terminal launcher layout', () => {
  it('keeps the six Codex controls in shortcut order without the old header or profile descriptions', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel' })
    try {
      const html = renderToStaticMarkup(createElement(TerminalLauncher, {
        projectId: 'project-1',
        onClose: () => {},
        onStart: async () => {}
      }))

      expect(html).toContain('Terminal / tmux name')
      expect(html).toContain('Login shell')
      expect(html).toContain('Codex thread ID')
      expect(html).toContain('YOLO mode')
      expect(html).toContain('data-profile="shell"')
      expect(html).toContain('data-profile="codex"')
      expect(html).toContain('data-profile="claude"')
      expect(html).toContain('Only use in isolated or disposable environments.')
      expect(html).not.toContain('What do you want to run?')
      expect(html).not.toContain('Your normal interactive shell')
      expect(html.match(/<kbd class="modal-shortcut-hint">[1-6]<\/kbd>/g)).toHaveLength(6)
      expect(html).toContain('<kbd>Cmd</kbd><span>+</span><kbd>Enter</kbd>')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
