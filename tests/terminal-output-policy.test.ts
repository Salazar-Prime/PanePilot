import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import {
  persistsTerminalOutput,
  retainedVolatileTerminalOutput,
  TerminalManager
} from '../src/main/terminal-manager'
import type { TerminalSession } from '../src/shared/types'

describe('terminal output persistence policy', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('keeps Codex output volatile while preserving other terminal output', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-output-policy-'))
    const store = new Store(appDataPath)
    store.syncConnections([])
    const folder = join(appDataPath, 'project')
    mkdirSync(folder)
    const project = store.createProject({
      type: 'terminal',
      name: 'Output policy',
      connectionId: 'local',
      folder,
      repositoryUrl: null
    })
    const createSession = (name: string, profile: 'codex' | 'claude' | 'shell') =>
      store.createSession({
        projectId: project.id,
        name,
        profile,
        providerSessionName: null,
        customCommand: null,
        backend: 'pty',
        tmuxName: null,
        dangerousMode: false
      })
    const codex = createSession('Codex', 'codex')
    const claude = createSession('Claude', 'claude')
    const shell = createSession('Shell', 'shell')
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )
    const outputHarness = manager as unknown as {
      retainTerminalOutput(session: TerminalSession, data: string): void
      flushOutput(sessionId: string): void
    }

    outputHarness.retainTerminalOutput(codex, 'volatile Codex output')
    outputHarness.retainTerminalOutput(claude, 'saved Claude output')
    outputHarness.retainTerminalOutput(shell, 'saved shell output')
    outputHarness.flushOutput(claude.id)
    outputHarness.flushOutput(shell.id)

    expect(store.getSession(codex.id)?.output).toBe('')
    expect(store.getSession(claude.id)?.output).toBe('saved Claude output')
    expect(store.getSession(shell.id)?.output).toBe('saved shell output')

    store.setSessionState(codex.id, 'completed')
    expect(manager.attach(codex.id, 100, 30).output).toBe('volatile Codex output')
    manager.shutdown()

    const reopenedManager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )
    expect(reopenedManager.attach(codex.id, 100, 30).output).toBe('')
    reopenedManager.shutdown()
    store.close()
  })

  it('bounds the volatile replay buffer without breaking UTF-8', () => {
    expect(persistsTerminalOutput('codex')).toBe(false)
    expect(persistsTerminalOutput('claude')).toBe(true)
    expect(persistsTerminalOutput('shell')).toBe(true)

    const retained = retainedVolatileTerminalOutput(`prefix-${'🙂'.repeat(10)}-end`, 17)
    expect(Buffer.byteLength(retained, 'utf8')).toBeLessThanOrEqual(17)
    expect(retained.endsWith('-end')).toBe(true)
    expect(retained).not.toContain('\ufffd')
  })
})
