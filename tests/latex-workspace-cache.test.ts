import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('LaTeX workspace navigation cache', () => {
  it('reuses a successful project map while refreshing it in the background', () => {
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

    expect(source).toContain('const latexWorkspaceCache = new Map')
    expect(source).toContain('latexWorkspaceCache.get(project.id)')
    expect(source).toContain('latexWorkspaceCache.set(project.id, next)')
    expect(source).toContain('requestId !== workspaceRequestRef.current')
    expect(source).toContain('if (cached) setRefreshError(message)')
    expect(source).not.toContain('setWorkspace(null)')
  })
})
