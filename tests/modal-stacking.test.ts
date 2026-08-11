import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('workspace modal stacking', () => {
  it('does not isolate each split pane above sibling modal backdrops', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/shortcut-overlay.css'),
      'utf8'
    )
    const workspaceRule = css.match(/\.project-workspace\s*\{([^}]*)\}/)

    expect(workspaceRule).not.toBeNull()
    expect(workspaceRule?.[1]).not.toContain('isolation:')
  })
})
