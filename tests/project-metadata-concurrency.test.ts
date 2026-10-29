import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectMetadataService } from '../src/main/project-metadata-service'
import type { Store } from '../src/main/store'
import type { Connection, LatexComment, Project } from '../src/shared/types'

const temporaryRoots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function projectFolder(): string {
  const root = mkdtempSync(join(tmpdir(), 'panepilot-comment-concurrency-'))
  temporaryRoots.push(root)
  return root
}

function client(folder: string, id = 'project') {
  const project = { id, type: 'latex', connectionId: 'local', folder }
  // All comment IO is real; only the database lookup is replaced with fixtures.
  const store = {
    getProjectWithoutOutput: () => project,
    getConnection: () => ({ id: 'local', kind: 'local', name: 'Local fixture' })
  } as unknown as Store
  return new ProjectMetadataService(store)
}

function selection(body: string) {
  return {
    path: 'main.tex',
    selectedText: 'hello',
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 6,
    prefixContext: '',
    suffixContext: '',
    body
  }
}

function legacyComment(id = 'legacy'): LatexComment {
  return {
    ...selection('Migrated comment'),
    id,
    projectId: 'legacy-project-id',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('LaTeX comment transactions in one process', () => {
  it('preserves parallel creates across services and canonical folder aliases', async () => {
    const root = projectFolder()
    const alias = join(projectFolder(), 'project-alias')
    symlinkSync(root, alias, 'dir')
    const first = client(root, 'first-client-project')
    const second = client(alias, 'second-client-project')
    const created = await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        index % 2 === 0
          ? first.createLatexComment('first-client-project', selection(`Comment ${index}`))
          : second.createLatexComment('second-client-project', selection(`Comment ${index}`))
      )
    )

    const persisted = await first.listLatexComments('first-client-project')
    expect(new Set(persisted.map(({ id }) => id))).toEqual(new Set(created.map(({ id }) => id)))
    expect(persisted.every(({ projectId }) => projectId === 'first-client-project')).toBe(true)
    const file = JSON.parse(readFileSync(join(root, '.panepilot', 'latex-comments.json'), 'utf8'))
    expect(file.comments).toHaveLength(created.length)
    expect(file.comments.every((comment: Record<string, unknown>) => !('projectId' in comment))).toBe(true)
  })

  it('does not lose new records or resurrect deletes during concurrent mutations', async () => {
    const root = projectFolder()
    const first = client(root)
    const second = client(root)
    const originals = await Promise.all(
      ['Delete A', 'Delete B', 'Keep'].map((body) => first.createLatexComment('project', selection(body)))
    )
    const [, newA, , newB] = await Promise.all([
      first.deleteLatexComment('project', originals[0]!.id),
      second.createLatexComment('project', selection('New A')),
      second.deleteLatexComment('project', originals[1]!.id),
      first.createLatexComment('project', selection('New B')),
      second.deleteLatexComment('project', originals[0]!.id)
    ])

    expect(new Set((await first.listLatexComments('project')).map(({ id }) => id))).toEqual(
      new Set([originals[2]!.id, newA.id, newB.id])
    )
  })

  it('serializes the initial migration with competing lists and creates', async () => {
    const root = projectFolder()
    const first = client(root)
    const second = client(root)
    const legacy = legacyComment()
    const otherLegacy = legacyComment('other-client-legacy')
    const [migrated, competingRead, created] = await Promise.all([
      first.listLatexComments('project', [legacy]),
      second.listLatexComments('project', [otherLegacy]),
      second.createLatexComment('project', selection('New comment'), [legacy])
    ])

    const persisted = await first.listLatexComments('project')
    const migratedRecord = persisted.find(({ id }) => id !== created.id)!
    // Canonical path resolution is asynchronous: either client may acquire the
    // first transaction, but later operations must respect its authoritative file.
    expect([legacy.id, otherLegacy.id]).toContain(migratedRecord.id)
    expect(persisted).toHaveLength(2)
    expect(persisted).toContainEqual(created)
    expect(migrated).toContainEqual(migratedRecord)
    expect(competingRead).toContainEqual(migratedRecord)
  })

  it('does not repeat migration after a concurrent delete empties the file', async () => {
    const root = projectFolder()
    const first = client(root)
    const second = client(root)
    const legacy = legacyComment()

    const [, listed] = await Promise.all([
      first.deleteLatexComment('project', legacy.id, [legacy]),
      second.listLatexComments('project', [legacy])
    ])

    expect(listed.every(({ id }) => id === legacy.id)).toBe(true)
    expect(await first.listLatexComments('project', [legacy])).toEqual([])
  })

  it('allows queued operations after failed validation and failed migration', async () => {
    const root = projectFolder()
    const first = client(root)
    const second = client(root)
    const legacy = legacyComment()
    await expect(
      first.listLatexComments('project', [{ ...legacy, body: '' }])
    ).rejects.toThrow('invalid comment')
    expect(await second.listLatexComments('project', [legacy])).toEqual([
      { ...legacy, projectId: 'project' }
    ])

    const mutations = await Promise.allSettled([
      first.createLatexComment('project', selection('')),
      second.createLatexComment('project', selection('Valid after failure'))
    ])
    expect(mutations[0]!.status).toBe('rejected')
    expect(mutations[1]!.status).toBe('fulfilled')
    expect((await first.listLatexComments('project')).map(({ body }) => body)).toEqual([
      legacy.body, 'Valid after failure'
    ])
  })

  it('recovers after a malformed authoritative file is repaired', async () => {
    const root = projectFolder()
    mkdirSync(join(root, '.panepilot'))
    const path = join(root, '.panepilot', 'latex-comments.json')
    writeFileSync(path, '{bad json')
    const metadata = client(root)
    await expect(metadata.listLatexComments('project')).rejects.toThrow('not valid UTF-8 JSON')

    writeFileSync(path, JSON.stringify({ version: 1, comments: [] }))
    const created = await metadata.createLatexComment('project', selection('After repair'))
    expect(await metadata.listLatexComments('project')).toEqual([created])
  })

  it('lets another project proceed while one project transaction is waiting', async () => {
    const first = client(projectFolder())
    const second = client(projectFolder())
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let markReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve })
    // Hold one real read at the async boundary to model a slow filesystem/SSH
    // response without adding an artificial delay to every test.
    const reader = first as unknown as {
      readLatexComments(project: Project, connection: Connection): Promise<unknown | null>
    }
    const read = reader.readLatexComments.bind(reader)
    vi.spyOn(reader, 'readLatexComments').mockImplementationOnce(async (project, connection) => {
      const result = await read(project, connection)
      markReadStarted()
      await gate
      return result
    })
    let firstFinished = false
    const pending = first.createLatexComment('project', selection('Waiting')).then((comment) => {
      firstFinished = true
      return comment
    })
    try {
      await readStarted
      const created = await second.createLatexComment('project', selection('Independent'))
      expect(firstFinished).toBe(false)
      expect(await second.listLatexComments('project')).toEqual([created])
    } finally {
      release()
      await pending
    }
    expect(firstFinished).toBe(true)
  })
})
