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
    expect(app).toContain('onSessionSelected={(id) => {\n                    expandSidebarProject(paneAProject.id)')
    expect(app).toContain('onSessionSelected={(id) => {\n                      expandSidebarProject(paneBProject.id)')
    expect(app).toContain('onSelectSession={(id) => {\n                    setSelectedSessionId(id)')
    expect(app).toContain('onSelectSession={(id) => {\n                      setPaneBSessionId(id)')
  })
})
