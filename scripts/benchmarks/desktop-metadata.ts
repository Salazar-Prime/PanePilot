import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectMetadataService } from '../../src/main/project-metadata-service'
import type { Store } from '../../src/main/store'

export async function runMetadataConcurrencyProbe() {
  const root = await mkdtemp(join(tmpdir(), 'panepilot-comment-race-'))
  try {
    const project = { id: 'fixture-project', type: 'latex', connectionId: 'local', folder: root }
    // The service's project lookup is stubbed; its file read/write methods are
    // real. No database, provider, remote host, or user project is accessed.
    const fixtureStore = {
      getProjectWithoutOutput: () => project,
      getConnection: () => ({ id: 'local', kind: 'local', name: 'Local fixture' })
    } as unknown as Store
    const service = new ProjectMetadataService(fixtureStore)
    await service.listLatexComments(project.id)
    const selection = {
      path: 'main.tex', selectedText: 'hello', startLine: 1, startColumn: 1,
      endLine: 1, endColumn: 6, prefixContext: '', suffixContext: ''
    }
    const created = await Promise.all([
      service.createLatexComment(project.id, { ...selection, body: 'First simultaneous comment' }),
      service.createLatexComment(project.id, { ...selection, body: 'Second simultaneous comment' })
    ])
    const persisted = await service.listLatexComments(project.id)
    assert.equal(created.length, 2)
    return {
      name: 'latex-comment-concurrent-create',
      method: 'Two concurrent calls to actual ProjectMetadataService.createLatexComment, using a temporary local project folder and stubbed project lookup.',
      successfulCreateCalls: created.length,
      persistedComments: persisted.length,
      lostSuccessfulCreates: created.filter(comment => !persisted.some(saved => saved.id === comment.id)).length,
      invariantSatisfied: created.every(comment => persisted.some(saved => saved.id === comment.id)),
      limitations: ['Service-level concurrency probe; not proof that one particular UI gesture triggers concurrent calls.',
        'Tests one process and local files. Cross-client and SSH races need their own integration tests.']
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
