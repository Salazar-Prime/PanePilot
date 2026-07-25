import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

let appDataPath: string | null = null

afterEach(() => {
  if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
  appDataPath = null
})

describe('archived project deletion', () => {
  it('only deletes archived projects and cascades local workspace records', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-project-delete-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const folder = join(appDataPath, 'project')
    mkdirSync(folder)
    const project = store.createProject({
      type: 'terminal',
      name: 'Project',
      connectionId: 'local',
      folder,
      repositoryUrl: null
    })
    store.createProjectAction({
      projectId: project.id,
      name: 'Check',
      command: 'npm test'
    })

    try {
      expect(() => store.deleteProject(project.id)).toThrow(
        'Archive the project before deleting it.'
      )
      store.archiveProject(project.id, true)
      store.deleteProject(project.id)

      expect(store.getProject(project.id)).toBeNull()
      expect(store.listProjects()).toEqual([])
    } finally {
      store.close()
    }
  })
})
