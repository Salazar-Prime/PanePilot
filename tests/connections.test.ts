import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('SSH connection refresh', () => {
  it('adds new aliases, removes unused stale aliases, and preserves project connections', () => {
    const appData = mkdtempSync(join(tmpdir(), 'panepilot-connections-'))
    temporaryRoots.push(appData)
    const store = new Store(appData)
    try {
      store.syncConnections(['kept-host', 'stale-host'])
      const projectFolder = join(appData, 'project')
      mkdirSync(projectFolder)
      store.createProject({
        type: 'terminal',
        name: 'Remote project',
        connectionId: 'ssh:kept-host',
        folder: '/srv/project',
        repositoryUrl: null
      })

      store.syncConnections(['new-host'])

      expect(store.listConnections().map((connection) => connection.id)).toEqual([
        'local',
        'ssh:kept-host',
        'ssh:new-host'
      ])
    } finally {
      store.close()
    }
  })
})
