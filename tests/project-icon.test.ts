import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { normalizeProjectIcon } from '../src/shared/project-icon'

let appDataPath: string | null = null

afterEach(() => {
  if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
  appDataPath = null
})

describe('project icons', () => {
  it('accepts one Unicode grapheme, including a composed emoji', () => {
    expect(normalizeProjectIcon('  λ  ')).toBe('λ')
    expect(normalizeProjectIcon('🧑‍💻')).toBe('🧑‍💻')
    expect(normalizeProjectIcon('')).toBeNull()
    expect(() => normalizeProjectIcon('two')).toThrow(
      'one Unicode symbol or emoji'
    )
  })

  it('migrates, saves, and resets the icon in project storage', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-project-icon-'))
    const initial = new Store(appDataPath)
    initial.syncConnections([])
    const project = initial.createProject({
      type: 'terminal',
      name: 'Project',
      connectionId: 'local',
      folder: appDataPath,
      repositoryUrl: null
    })
    initial.close()

    const database = new DatabaseSync(
      join(appDataPath, 'project-console.sqlite')
    )
    database.exec('ALTER TABLE projects DROP COLUMN icon')
    database.close()

    const store = new Store(appDataPath)

    try {
      expect(store.getProject(project.id)?.icon).toBeNull()
      store.setProjectIcon(project.id, '🚀')
      expect(store.getProject(project.id)?.icon).toBe('🚀')
      store.setProjectIcon(project.id, null)
      expect(store.getProject(project.id)?.icon).toBeNull()
    } finally {
      store.close()
    }
  })
})
