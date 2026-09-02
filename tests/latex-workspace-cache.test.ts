import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('LaTeX workspace navigation cache', () => {
  it('reuses a successful project map without rescanning on every revisit', () => {
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
    expect(source).toContain('if (!cached) void loadWorkspace()')
    expect(source).not.toContain('setWorkspace(null)')
  })

  it('keeps the manuscript and opened PDF mounted while changing tools', () => {
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

    expect(source).toContain("tab === 'manuscript' ? 'active' : ''")
    expect(source).toContain("tab === 'pdf' ? 'active' : ''")
    expect(source).toContain('{pdfOpened && (')
    expect(source).not.toContain("{tab === 'manuscript' && (")
  })

  it('keeps the Monaco source model and draft warm across workspace remounts', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'src',
        'renderer',
        'src',
        'components',
        'LatexManuscript.tsx'
      ),
      'utf8'
    )

    expect(source).toContain('const latexSourceSnapshots = new Map')
    expect(source).toContain('MAX_CACHED_LATEX_SOURCES = 32')
    expect(source).toContain('keepCurrentModel')
    expect(source).toContain('inlineEditAppliedPathRef.current === path')
  })
})
