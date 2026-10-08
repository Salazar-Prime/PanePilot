import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { disclosureScrollDelta, disclosureTailHeight } from '../src/renderer/src/lib/sidebarDisclosure'

describe('sidebar disclosure geometry', () => {
  it('does not scroll when the whole expanded group fits', () => {
    expect(disclosureScrollDelta(100, 700, 150, 500)).toBe(0)
  })
  it('scrolls only the missing space into view', () => {
    expect(disclosureScrollDelta(100, 700, 600, 800)).toBe(108)
    expect(disclosureScrollDelta(100, 700, 50, 300)).toBe(-58)
  })
  it('keeps the heading reachable when the group exceeds a screen', () => {
    expect(disclosureScrollDelta(100, 700, 400, 1400)).toBe(292)
    expect(disclosureScrollDelta(100, 700, 108, 1400)).toBe(0)
  })
  it('reserves only the space required to avoid bottom-edge scroll clamping', () => {
    expect(disclosureTailHeight(500, 600, 800)).toBe(300)
    expect(disclosureTailHeight(250, 600, 800)).toBe(50)
    expect(disclosureTailHeight(0, 600, 800)).toBe(0)
    expect(disclosureTailHeight(0, 600, 100)).toBe(0)
    expect(disclosureTailHeight(500, 600, 1600)).toBe(0)
  })
  it('uses the same disclosure action in the project menu and Command-K without selecting the project', () => {
    const app = readFileSync('src/renderer/src/components/App.tsx', 'utf8')
    const action = app.slice(app.indexOf("id: 'sidebar-disclosure'"), app.indexOf('...(splitOpen', app.indexOf("id: 'sidebar-disclosure'")))
    expect(action).toContain('Expand project in sidebar')
    expect(action).toContain('Collapse project in sidebar')
    expect(action).toContain('toggleProjectCollapsed(target.id)')
    expect(action).not.toContain('selectProject(')
    const reveal = app.slice(app.indexOf('  const sidebarActiveSessionId'), app.indexOf('  const temporaryChatProject'))
    expect(reveal).not.toContain('collapsedProjectIds,')
    expect(reveal).toContain('[data-expanded="false"]')
  })
})
