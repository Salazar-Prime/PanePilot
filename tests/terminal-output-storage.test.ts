import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'

const OUTPUT_LIMIT = 512 * 1024
const OUTPUT_CHUNK_LIMIT = 4 * 1024

describe('terminal output chunk storage', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  function createSession() {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-output-storage-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const folder = join(appDataPath, 'project')
    mkdirSync(folder)
    const project = store.createProject({
      type: 'terminal',
      name: 'Output storage',
      connectionId: 'local',
      folder,
      repositoryUrl: null
    })
    const session = store.createSession({
      projectId: project.id,
      name: 'Shell',
      profile: 'shell',
      providerSessionName: null,
      customCommand: null,
      backend: 'pty',
      tmuxName: null,
      dangerousMode: false
    })
    return { store, project, session }
  }

  it('preserves ordered output across reloads while pruning whole old chunks', () => {
    const { store, session } = createSession()
    const appended = Array.from(
      { length: 20 },
      (_, index) => `line-${index.toString().padStart(2, '0')}\r\n`.repeat(60)
    ).join('')

    store.replaceOutput(session.id, 'x'.repeat(OUTPUT_LIMIT))
    for (let start = 0; start < appended.length; start += 600) {
      store.appendOutput(session.id, appended.slice(start, start + 600))
    }

    const output = store.getSession(session.id)?.output ?? ''
    expect(output.length).toBeLessThanOrEqual(OUTPUT_LIMIT)
    expect(output.length).toBeGreaterThan(OUTPUT_LIMIT - OUTPUT_CHUNK_LIMIT)
    expect(output.endsWith(appended)).toBe(true)
    const database = (store as unknown as { db: DatabaseSync }).db
    const chunkStats = database
      .prepare(
        `SELECT MAX(byte_count) AS largest, COUNT(*) AS count
         FROM terminal_output_chunks
         WHERE terminal_session_id = ?`
      )
      .get(session.id) as { largest: number; count: number }
    expect(chunkStats.largest).toBeLessThanOrEqual(OUTPUT_CHUNK_LIMIT)
    expect(chunkStats.count).toBeLessThanOrEqual(
      Math.ceil(OUTPUT_LIMIT / OUTPUT_CHUNK_LIMIT)
    )
    store.close()

    const reopened = new Store(appDataPath!)
    expect(reopened.getSession(session.id)?.output).toBe(output)
    reopened.close()
  })

  it('migrates legacy saved output and deletes chunks with the session', () => {
    const { store, session } = createSession()
    const database = (store as unknown as { db: DatabaseSync }).db
    const legacyOutput = '🙂'.repeat(140_000)
    database
      .prepare('DELETE FROM terminal_output_chunks WHERE terminal_session_id = ?')
      .run(session.id)
    database
      .prepare('UPDATE terminal_sessions SET output = ? WHERE id = ?')
      .run(legacyOutput, session.id)
    store.close()

    const migrated = new Store(appDataPath!)
    expect(migrated.getSession(session.id)?.output).toBe(legacyOutput)
    const migratedDatabase = (
      migrated as unknown as { db: DatabaseSync }
    ).db
    const chunkCount = migratedDatabase
      .prepare(
        `SELECT COUNT(*) AS count
         FROM terminal_output_chunks
         WHERE terminal_session_id = ?`
      )
      .get(session.id) as { count: number }
    expect(chunkCount.count).toBeGreaterThan(1)

    migrated.setSessionState(session.id, 'completed')
    migrated.deleteSession(session.id)
    const remainingChunks = migratedDatabase
      .prepare(
        `SELECT COUNT(*) AS count
         FROM terminal_output_chunks
         WHERE terminal_session_id = ?`
      )
      .get(session.id) as { count: number }
    expect(remainingChunks.count).toBe(0)
    migrated.close()
  })

  it('keeps UTF-8 characters intact while enforcing the byte limit', () => {
    const { store, session } = createSession()
    const suffix = 'final-🙂-line\r\n'
    const output = `${'🙂\0'.repeat(150_000)}${suffix}`

    store.replaceOutput(session.id, output)

    const retained = store.getSession(session.id)?.output ?? ''
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(OUTPUT_LIMIT)
    expect(retained.endsWith(suffix)).toBe(true)
    expect(retained).toContain('\0')
    expect(retained).not.toContain('\ufffd')
    store.close()
  })
})
