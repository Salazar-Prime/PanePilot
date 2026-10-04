import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync('src/renderer/src/components/App.tsx', 'utf8')
const between = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end, app.indexOf(start)))

describe('sidebar collapse selection routing', () => {
  it('project clicks and opening a project in a split pane preserve collapse state', () => {
    for (const body of [
      between('  function selectProject(', '  async function selectSession('),
      between('  function openProjectInPane(', '  function swapPanes(')
    ]) {
      expect(body).toContain('defaultSessionIdFor(')
      expect(body).not.toContain('expandSidebarProject(')
      expect(body).not.toContain('toggleProjectCollapsed(')
    }
  })

  it('does not expand in response to active-session hydration or sidebar visibility', () => {
    const effects = between('  const sidebarActiveSessionId =', '  const temporaryChatProject =')
    expect(effects).toContain('sidebarRevealDelta(')
    expect(effects).not.toContain('expandSidebarProject(')
  })

  it('explicit terminal jumps still expand the exact owning project', () => {
    expect(between('  async function selectSession(', '  function activateWorkspaceDestination(')).toContain('expandSidebarProject(projectId)')
    expect(between('  async function openSessionInPane(', '  async function createProject(')).toContain('expandSidebarProject(projectId)')
  })

  it('Command-arrow history switching preserves collapse while activating the exact terminal', () => {
    const body = between('  function activateWorkspaceDestination(', '  async function reconnectSession(')
    expect(body).not.toContain('expandSidebarProject(')
    expect(body).not.toContain('toggleProjectCollapsed(')
    expect(body).toContain('destination.sessionId ??')
    expect(body).toContain('recordSessionSelection(destination.sessionId)')
    expect(body).toContain('applyPaneSelection(pane, destination.projectId, sessionId)')
    expect(body).toContain('openSession(sessionId)')
  })

  it('workspace user selections reveal terminals in either pane, not passive selection synchronization', () => {
    expect(app).toContain('if (options?.revealSidebar !== false) expandSidebarProject(paneAProject.id)')
    expect(app).toContain('if (options?.revealSidebar !== false) expandSidebarProject(paneBProject.id)')
    expect(app).toContain('onSelectSession={(id) => {\n                    setSelectedSessionId(id)')
    expect(app).toContain('onSelectSession={(id) => {\n                      setPaneBSessionId(id)')
  })

  it('number and cycling shortcuts preserve collapse in terminal and LaTeX workspaces', () => {
    const terminal = readFileSync('src/renderer/src/components/TerminalProjectWorkspace.tsx', 'utf8')
    expect(terminal).toContain('onSelectSession: (id) => selectSession(id, false)')
    const select = terminal.slice(terminal.indexOf('  async function selectSession('), terminal.indexOf('  async function startTerminal('))
    expect(select).toContain('onSessionSelected(id, { revealSidebar })')
    expect(select).toContain('onOpenSession(id)')
    expect(select).toContain('onSelectSession(id)')

    const latex = readFileSync('src/renderer/src/components/LatexProjectWorkspace.tsx', 'utf8')
    const shortcut = latex.slice(latex.indexOf('  async function selectShortcutSession('), latex.indexOf('  async function clearChanges('))
    expect(latex).toContain('onSelectSession: selectShortcutSession')
    expect(shortcut).toContain('onSessionSelected(id, { revealSidebar: false })')
    expect(shortcut).toContain('onSelectSession(id)')
  })
})
