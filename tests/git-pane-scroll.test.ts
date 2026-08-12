import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shouldLoadOlderGitCommits } from '../src/renderer/src/lib/gitPane'

function cssRule(css: string, selector: string): string {
  return css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? ''
}

describe('Git pane scrolling', () => {
  it('uses one scroll owner rather than competing working-tree and history scrollers', () => {
    const css = readFileSync(
      join(process.cwd(), 'src/renderer/src/git-pane.css'),
      'utf8'
    )

    expect(cssRule(css, '.git-pane-scroll')).toContain('overflow-y: auto')
    expect(cssRule(css, '.git-pane-scroll')).toContain(
      'overscroll-behavior: contain'
    )
    expect(cssRule(css, '.git-working-tree')).not.toContain('overflow-y')
    expect(cssRule(css, '.git-commit-list')).not.toContain('overflow-y')
  })

  it('requests another page when the unified pane nears the bottom', () => {
    expect(shouldLoadOlderGitCommits(500, 500, 1_200)).toBe(true)
    expect(shouldLoadOlderGitCommits(200, 500, 1_200)).toBe(false)
    expect(shouldLoadOlderGitCommits(0, 500, 500)).toBe(false)
  })
})
