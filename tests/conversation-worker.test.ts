import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { AsyncConversationIndexer } from '../src/main/conversation-indexer-client'

let fixture: string
let workerPath: string
beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), 'panepilot-archive-worker-'))
  workerPath = join(fixture, 'worker.cjs')
  buildSync({ entryPoints: [resolve('src/main/conversation-indexer-worker.ts')], outfile: workerPath,
    bundle: true, platform: 'node', format: 'cjs' })
  for (let i = 0; i < 40; i++) writeFileSync(join(fixture, `${i}.jsonl`), [
    JSON.stringify({ type: 'session_meta', payload: { id: `thread-${i}`, cwd: '/project' } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: `${'x'.repeat(2048)} needle-${i}` } })
  ].join('\n'))
})
afterAll(() => { rmSync(fixture, { recursive: true, force: true }) })

describe('conversation archive worker', () => {
  it('keeps main-loop callbacks responsive and coalesces requests without dropping detail', async () => {
    let workers = 0
    const client = new AsyncConversationIndexer(options => {
      workers++
      return new Worker(workerPath, { workerData: options })
    }, { roots: [{ provider: 'codex', path: fixture }], cache: { maxDetailBytes: 16 * 1024, maxDetailEntries: 2 } })
    try {
      let timerRan = false
      const timer = new Promise<void>(resolveTimer => setTimeout(() => { timerRan = true; resolveTimer() }, 0))
      const first = client.list('/project')
      const same = client.list('/project')
      expect(first).toBe(same)
      await timer
      expect(timerRan).toBe(true)
      const list = await first
      expect(list).toHaveLength(40)
      expect(workers).toBe(1)
      const detail = await client.get('/project', list[0].id)
      expect(detail.messages[0].content).toContain('needle-')
      const stats = await client.diagnostics()
      expect(stats.detailEntries).toBeLessThanOrEqual(2)
      expect(stats.detailBytes).toBeLessThanOrEqual(16 * 1024)
      await expect(client.get('/other', list[0].id)).rejects.toThrow('not found')
      expect((await client.list('/project', 'needle-39'))).toHaveLength(1)
    } finally { client.dispose() }
  })

  it('rejects pending work on disposal and does not restart a disposed client', async () => {
    const client = new AsyncConversationIndexer(() => new Worker('setInterval(() => {}, 1000)', { eval: true }))
    const pending = client.list('/project')
    const rejection = expect(pending).rejects.toThrow('closed')
    client.dispose()
    await rejection
    await expect(client.list('/project')).rejects.toThrow('closed')
  })

  it('clears rejected requests after a worker failure and can start a fresh worker', async () => {
    let attempts = 0
    const client = new AsyncConversationIndexer(options => ++attempts === 1
      ? new Worker('throw new Error("fixture failure")', { eval: true })
      : new Worker(workerPath, { workerData: options }), { roots: [{ provider: 'codex', path: fixture }] })
    try {
      await expect(client.list('/project')).rejects.toThrow('fixture failure')
      expect(await client.list('/project')).toHaveLength(40)
      expect(attempts).toBe(2)
    } finally { client.dispose() }
  })
})
