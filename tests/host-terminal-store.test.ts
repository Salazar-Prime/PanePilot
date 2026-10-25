import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

const locations: string[] = []

function createStore(): { path: string; store: Store } {
  const path = mkdtempSync(join(tmpdir(), 'panepilot-host-terminals-'))
  locations.push(path)
  return { path, store: new Store(path) }
}

afterEach(() => {
  for (const path of locations.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('host terminal storage', () => {
  it('works without projects and derives the shell profile', () => {
    const { store } = createStore()
    const session = store.createHostTerminal({
      id: 'host-1',
      name: 'Host shell',
      backend: 'tmux',
      tmuxName: 'host-shell'
    })

    expect(session).toMatchObject({ id: 'host-1', profile: 'shell', state: 'idle' })
    expect(store.listHostTerminals()).toEqual([session])
    store.close()
  })

  it('persists records and state after reopening the store', () => {
    const { path, store } = createStore()
    const created = store.createHostTerminal({
      id: 'host-1',
      name: 'Persistent shell',
      backend: 'pty',
      tmuxName: null
    })
    store.setHostTerminalState(created.id, 'completed')
    store.close()

    const reopened = new Store(path)
    expect(reopened.getHostTerminal(created.id)).toMatchObject({
      id: created.id,
      backend: 'pty',
      state: 'completed'
    })
    reopened.close()
  })

  it('keeps host terminals independent of project deletion', () => {
    const { path, store } = createStore()
    store.syncConnections([])
    const folder = join(path, 'project')
    mkdirSync(folder)
    const project = store.createProject({
      type: 'terminal',
      name: 'Project',
      connectionId: 'local',
      folder,
      repositoryUrl: null
    })
    const session = store.createHostTerminal({
      id: 'host-1',
      name: 'Independent shell',
      backend: 'pty',
      tmuxName: null
    })

    store.archiveProject(project.id, true)
    store.deleteProject(project.id)
    expect(store.getHostTerminal(session.id)).toEqual(session)
    store.close()
  })

  it('rejects duplicate names', () => {
    const { store } = createStore()
    store.createHostTerminal({ id: 'host-1', name: 'Same name', backend: 'pty', tmuxName: null })

    expect(() =>
      store.createHostTerminal({ id: 'host-2', name: 'Same name', backend: 'tmux', tmuxName: 'same' })
    ).toThrow()
    store.close()
  })

  it('deletes only the exact row', () => {
    const { store } = createStore()
    store.createHostTerminal({ id: 'host-1', name: 'First', backend: 'pty', tmuxName: null })
    store.createHostTerminal({ id: 'host-2', name: 'Second', backend: 'pty', tmuxName: null })

    store.deleteHostTerminal('host-1')

    expect(store.getHostTerminal('host-1')).toBeNull()
    expect(store.listHostTerminals().map(({ id }) => id)).toEqual(['host-2'])
    store.close()
  })
})
