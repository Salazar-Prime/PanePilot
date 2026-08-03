import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

const OUTPUT_LIMIT = 512 * 1024
const APPEND_SIZE = Number(
  process.env.PANEPILOT_OUTPUT_BENCHMARK_APPEND_SIZE ?? 512
)
const APPEND_COUNT = Number(
  process.env.PANEPILOT_OUTPUT_BENCHMARK_APPEND_COUNT ?? 200
)
const runBenchmark = process.env.PANEPILOT_OUTPUT_BENCHMARK === '1'

function payload(index: number, length: number): string {
  const marker = `${index.toString(36).padStart(6, '0')}|`
  return marker.repeat(Math.ceil(length / marker.length)).slice(0, length)
}

describe('terminal output storage benchmark', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it.skipIf(!runBenchmark)(
    'reports WAL growth for a saturated saved-output buffer',
    () => {
      appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-output-benchmark-'))
      const store = new Store(appDataPath)
      store.syncConnections([])
      const folder = join(appDataPath, 'project')
      mkdirSync(folder)
      const project = store.createProject({
        type: 'terminal',
        name: 'Benchmark',
        connectionId: 'local',
        folder,
        repositoryUrl: null
      })
      const session = store.createSession({
        projectId: project.id,
        name: 'Output benchmark',
        profile: 'shell',
        providerSessionName: null,
        customCommand: null,
        backend: 'pty',
        tmuxName: null,
        dangerousMode: false
      })
      const database = (store as unknown as { db: DatabaseSync }).db
      const databasePath = join(appDataPath, 'project-console.sqlite')
      const walPath = `${databasePath}-wal`
      const lastAppend = payload(APPEND_COUNT - 1, APPEND_SIZE)

      store.replaceOutput(session.id, payload(-1, OUTPUT_LIMIT))
      database.exec('PRAGMA wal_autocheckpoint = 0')
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const initialWalBytes = existsSync(walPath) ? statSync(walPath).size : 0
      const startedAt = performance.now()

      for (let index = 0; index < APPEND_COUNT; index += 1) {
        store.appendOutput(session.id, payload(index, APPEND_SIZE))
      }

      const elapsedMs = performance.now() - startedAt
      const walBytes = (existsSync(walPath) ? statSync(walPath).size : 0) - initialWalBytes
      const output = store.getSession(session.id)?.output ?? ''
      const inputBytes = APPEND_SIZE * APPEND_COUNT
      const result = {
        appendCount: APPEND_COUNT,
        appendBytes: APPEND_SIZE,
        inputBytes,
        outputBytes: Buffer.byteLength(output),
        walBytes,
        walToInputRatio: Number((walBytes / inputBytes).toFixed(2)),
        elapsedMs: Number(elapsedMs.toFixed(2))
      }

      console.info(`PANEPILOT_OUTPUT_BENCHMARK ${JSON.stringify(result)}`)
      expect(output).toHaveLength(OUTPUT_LIMIT)
      expect(output.endsWith(lastAppend)).toBe(true)
      store.close()
    }
  )
})
