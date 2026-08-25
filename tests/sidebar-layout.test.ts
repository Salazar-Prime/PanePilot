import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  loadSidebarWidth,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  saveSidebarWidth
} from '../src/renderer/src/lib/sidebarLayout'

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('left sidebar layout', () => {
  it('persists one bounded client-local width', () => {
    const storage = new MemoryStorage()

    expect(loadSidebarWidth(storage)).toBe(DEFAULT_SIDEBAR_WIDTH)
    saveSidebarWidth(338, storage)
    expect(loadSidebarWidth(storage)).toBe(338)
    saveSidebarWidth(20_000, storage)
    expect(loadSidebarWidth(storage)).toBe(MAX_SIDEBAR_WIDTH)
  })

  it('recovers safely from invalid and out-of-range widths', () => {
    expect(clampSidebarWidth(1)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(1_000)).toBe(MAX_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })

  it('exposes an accessible resize separator beside the sidebar', () => {
    const source = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'src', 'components', 'App.tsx'),
      'utf8'
    )

    expect(source).toContain('className="sidebar-resizer"')
    expect(source).toContain('aria-label="Resize project sidebar"')
    expect(source).toContain('role="separator"')
    expect(source).toContain("'--sidebar-preferred-width': `${sidebarWidth}px`")
  })
})
