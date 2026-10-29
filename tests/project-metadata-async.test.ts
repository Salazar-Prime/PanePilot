import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectMetadataService } from '../src/main/project-metadata-service'
import { Store } from '../src/main/store'
import type { Connection, Project } from '../src/shared/types'

const roots: string[] = []
const stores: Store[] = []
const originalPath = process.env.PATH

function root() {
  const path = mkdtempSync(join(tmpdir(), 'panepilot-metadata-async-'))
  roots.push(path)
  return path
}

function client(folder: string, remote = false) {
  const store = new Store(root())
  stores.push(store)
  store.syncConnections(remote ? ['fixture-only'] : [])
  const project = store.createProject({
    type: 'terminal', name: 'Fixture', connectionId: remote ? 'ssh:fixture-only' : 'local',
    folder, repositoryUrl: null
  })
  return { store, project, metadata: new ProjectMetadataService(store) }
}

function fakeSsh(body?: string) {
  const bin = root()
  const path = join(bin, 'ssh')
  // Run only the service's Python against temporary directories, never SSH.
  const script = `#!/bin/sh
/bin/sleep 0.2
${body ?? `for panepilot_argument in "$@"; do
  panepilot_command="$panepilot_argument"
done
exec /bin/sh -c "$panepilot_command"`}
`
  writeFileSync(path, script)
  chmodSync(path, 0o700)
  process.env.PATH = `${bin}:${originalPath ?? ''}`
  return path
}

async function yieldsWhileWaiting<T>(operation: () => Promise<T>): Promise<T> {
  let settled = false
  const timer = new Promise<boolean>((resolve) => setTimeout(() => resolve(settled), 0))
  const pending = operation().finally(() => { settled = true })
  try {
    expect(await timer).toBe(false)
  } finally {
    await pending
  }
  return pending
}

afterEach(() => {
  vi.restoreAllMocks()
  if (originalPath == null) delete process.env.PATH
  else process.env.PATH = originalPath
  for (const store of stores.splice(0)) store.close()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('asynchronous project metadata', () => {
  it('yields during every delayed remote Notes operation and preserves migration/content', async () => {
    fakeSsh()
    const folder = root()
    writeFileSync(join(folder, '.notes-panepilot'), '# Legacy fixture\n')
    const { project, metadata } = client(folder, true)
    expect(await yieldsWhileWaiting(() => metadata.listNotes(project.id)))
      .toMatchObject([{ path: 'Project notes.md' }])
    expect(existsSync(join(folder, '.notes-panepilot'))).toBe(false)
    const note = await yieldsWhileWaiting(() => metadata.createNote(project.id, '日本語'))
    expect(note.content).toBe('# 日本語\n\n')
    expect((await yieldsWhileWaiting(() => metadata.writeNote(project.id, note.path, '# Saved 👋\n'))).content)
      .toBe('# Saved 👋\n')
    expect((await yieldsWhileWaiting(() => metadata.readNote(project.id, note.path))).content)
      .toBe('# Saved 👋\n')
    const renamed = await yieldsWhileWaiting(() => metadata.renameNote(project.id, note.path, 'Renamed'))
    expect(renamed.path).toBe('Renamed.md')
    await yieldsWhileWaiting(() => metadata.deleteNote(project.id, renamed.path))
    expect(existsSync(join(folder, '.panepilot', 'notes', renamed.path))).toBe(false)
  })

  it('yields during every delayed remote Actions operation without sharing client-local run state', async () => {
    fakeSsh()
    const folder = root()
    const { project, store, metadata } = client(folder, true)
    const legacy = store.createProjectAction({ projectId: project.id, name: 'Legacy', command: 'true' })
    expect(await yieldsWhileWaiting(() => metadata.syncActions(project.id))).toEqual([legacy])
    const created = await yieldsWhileWaiting(() => metadata.createAction({
      projectId: project.id, name: 'Build', command: 'printf fixture'
    }))
    expect((await yieldsWhileWaiting(() => metadata.updateAction({
      actionId: created.id, name: 'Check', command: 'printf checked'
    }))).name).toBe('Check')
    const shared = JSON.parse(readFileSync(join(folder, '.panepilot', 'actions.json'), 'utf8'))
    expect(shared.actions.find(({ id }: { id: string }) => id === created.id))
      .toEqual({ id: created.id, name: 'Check', command: 'printf checked' })
    await yieldsWhileWaiting(() => metadata.deleteAction(created.id))
    expect(await metadata.syncActions(project.id)).toEqual([legacy])
  })

  it('returns current client-local Action run state after a slow initial migration', async () => {
    const folder = root()
    const { project, store, metadata } = client(folder)
    const action = store.createProjectAction({ projectId: project.id, name: 'Legacy', command: 'true' })
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writing = new Promise<void>((resolve) => { started = resolve })
    const writer = metadata as unknown as {
      writeActions(project: Project, connection: Connection, actions: Array<{ id: string; name: string; command: string }>): Promise<void>
    }
    const write = writer.writeActions.bind(writer)
    vi.spyOn(writer, 'writeActions').mockImplementationOnce(async (...args) => {
      await write(...args)
      started()
      await gate
    })
    const pending = metadata.syncActions(project.id)
    try {
      await writing
      const run = store.createSession({
        projectId: project.id, kind: 'action', name: 'Fixture run', profile: 'custom',
        providerSessionName: null, customCommand: 'true', backend: 'pty',
        tmuxName: null, dangerousMode: false
      })
      store.setProjectActionSession(action.id, run.id)
      release()
      expect(await pending).toEqual([expect.objectContaining({ id: action.id, lastSessionId: run.id })])
      expect(JSON.parse(readFileSync(join(folder, '.panepilot', 'actions.json'), 'utf8')).actions)
        .toEqual([{ id: action.id, name: 'Legacy', command: 'true' }])
    } finally {
      release()
      await pending
    }
  })

  it('serializes parallel local Action changes across clients and canonical folder aliases', async () => {
    const folder = root()
    const alias = join(root(), 'project')
    symlinkSync(folder, alias, 'dir')
    const first = client(folder)
    const second = client(alias)
    const created = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const owner = index % 2 ? first : second
      return owner.metadata.createAction({ projectId: owner.project.id, name: `Action ${index}`, command: 'true' })
    }))
    expect(new Set((await first.metadata.syncActions(first.project.id)).map(({ id }) => id)))
      .toEqual(new Set(created.map(({ id }) => id)))
    await second.metadata.syncActions(second.project.id)
    const [, updated, added] = await Promise.all([
      first.metadata.deleteAction(created[0]!.id),
      second.metadata.updateAction({ actionId: created[1]!.id, name: 'Updated', command: 'false' }),
      first.metadata.createAction({ projectId: first.project.id, name: 'Additional', command: 'true' })
    ])
    const persisted = await first.metadata.syncActions(first.project.id)
    expect(new Set(persisted.map(({ id }) => id)))
      .toEqual(new Set([...created.slice(1).map(({ id }) => id), added.id]))
    expect(persisted.find(({ id }) => id === updated.id)).toMatchObject({ name: 'Updated', command: 'false' })
  })

  it('serializes note migration and colliding creates across local service instances', async () => {
    const folder = root()
    writeFileSync(join(folder, '.notes-panepilot'), '# Legacy\n')
    const first = client(folder)
    const second = client(folder)
    const [listed, , results] = await Promise.all([
      first.metadata.listNotes(first.project.id),
      second.metadata.listNotes(second.project.id),
      Promise.allSettled([
        first.metadata.createNote(first.project.id, 'Same name'),
        second.metadata.createNote(second.project.id, 'Same name')
      ])
    ])
    expect(listed).toContainEqual(expect.objectContaining({ path: 'Project notes.md' }))
    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected'])
    expect((await first.metadata.listNotes(first.project.id)).map(({ path }) => path).sort())
      .toEqual(['Project notes.md', 'Same name.md'])
    expect((await first.metadata.readNote(first.project.id, 'Project notes.md')).content).toBe('# Legacy\n')
  })

  it('rejects failed, malformed, and oversized remote responses and releases the queue', async () => {
    const ssh = fakeSsh('printf "Permission denied\\n" >&2\nexit 255')
    const { project, metadata } = client(root(), true)
    await expect(metadata.listNotes(project.id)).rejects.toThrow('Permission denied')
    writeFileSync(ssh, '#!/bin/sh\nprintf "invalid json"\n')
    await expect(metadata.listNotes(project.id)).rejects.toThrow('not valid JSON')
    writeFileSync(ssh, '#!/bin/sh\nexec /usr/bin/head -c 4194305 /dev/zero\n')
    await expect(metadata.listNotes(project.id)).rejects.toThrow('too large')
    writeFileSync(ssh, '#!/bin/sh\nprintf "[]"\n')
    expect(await metadata.listNotes(project.id)).toEqual([])
  })

  it.each([false, true])('keeps path/symlink/size guards after async conversion (remote=%s)', async (remote) => {
    if (remote) fakeSsh()
    const folder = root()
    const { project, metadata } = client(folder, remote)
    await metadata.createNote(project.id, 'Safe')
    const outside = join(root(), 'outside.md')
    writeFileSync(outside, 'Do not modify')
    symlinkSync(outside, join(folder, '.panepilot', 'notes', 'Linked.md'))
    await expect(metadata.writeNote(project.id, 'Linked.md', 'modified')).rejects.toThrow('not found')
    await expect(metadata.readNote(project.id, '../outside.md')).rejects.toThrow('invalid')
    await expect(metadata.renameNote(project.id, 'Safe.md', '../escape')).rejects.toThrow('reserved characters')
    await expect(metadata.writeNote(project.id, 'Safe.md', 'x'.repeat(1024 * 1024 + 1)))
      .rejects.toThrow('1 MB or smaller')
    expect(readFileSync(outside, 'utf8')).toBe('Do not modify')
    expect((await metadata.readNote(project.id, 'Safe.md')).content).toBe('# Safe\n\n')
  })

  it('leaves valid Action transactions usable after a rejected update', async () => {
    const { project, metadata } = client(root())
    const action = await metadata.createAction({ projectId: project.id, name: 'Original', command: 'true' })
    const results = await Promise.allSettled([
      metadata.updateAction({ actionId: action.id, name: '', command: 'true' }),
      metadata.createAction({ projectId: project.id, name: 'Still works', command: 'true' })
    ])
    expect(results.map(({ status }) => status)).toEqual(['rejected', 'fulfilled'])
    expect((await metadata.syncActions(project.id)).map(({ name }) => name)).toEqual(['Original', 'Still works'])
  })
})
