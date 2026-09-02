import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function component(name: string): string {
  return readFileSync(
    join(
      process.cwd(),
      'src',
      'renderer',
      'src',
      'components',
      name
    ),
    'utf8'
  )
}

describe('project switching performance contracts', () => {
  it('owns terminal acknowledgement only at the app selection boundary', () => {
    const app = component('App.tsx')
    const terminalWorkspace = component('TerminalProjectWorkspace.tsx')
    const latexWorkspace = component('LatexProjectWorkspace.tsx')

    expect(app.match(/terminals\.acknowledge/g)).toHaveLength(1)
    expect(terminalWorkspace).not.toContain('terminals.acknowledge')
    expect(latexWorkspace).not.toContain('terminals.acknowledge')
  })

  it('coalesces discovery for unique visible connections without zero-change refreshes', () => {
    const app = component('App.tsx')

    expect(app.match(/terminals\.discover/g)).toHaveLength(1)
    expect(app).toContain('new Set(')
    expect(app).toContain('A zero-change')
    expect(app).not.toContain('if (active) await refresh()')
  })

  it('uses direct state patches and targeted project metadata refreshes', () => {
    const app = component('App.tsx')

    expect(app).toContain('withTerminalState(project, event)')
    expect(app).toContain('scheduleProjectRefresh(event.projectId)')
    expect(app).toContain('.get(projectId)')
    expect(app).toContain('onChanged={refreshProject}')
  })

  it('memoizes sidebar ordering and bounds focused-project Git caches', () => {
    const app = component('App.tsx')

    expect(app).toContain('const sidebarConnectionGroups = useMemo(')
    expect(app).toContain('PROJECT_READ_CACHE_LIMIT = 64')
    expect(app).toContain('cacheProjectRead(gitStatusCache')
    expect(app).toContain('cacheProjectRead(repositoryVisibilityCache')
  })

  it('keeps periodic terminal discovery on output-free project hydration', () => {
    const manager = readFileSync(
      join(process.cwd(), 'src', 'main', 'terminal-manager.ts'),
      'utf8'
    )

    expect(manager).not.toContain('this.store.listProjects()')
    expect(manager).not.toContain('this.store.getProject(')
    expect(manager).toContain('this.store.listProjectsForRuntime()')
    expect(manager).toContain('this.store.getProjectForRuntime(')
  })
})
