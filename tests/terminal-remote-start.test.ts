import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'

describe('remote terminal start', () => {
  let temporaryRoot: string | null = null
  const originalPath = process.env.PATH
  const originalShell = process.env.SHELL

  afterEach(() => {
    process.env.PATH = originalPath
    if (originalShell == null) delete process.env.SHELL
    else process.env.SHELL = originalShell
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = null
  })

  it('does not block Electron while SSH checks tmux', async () => {
    temporaryRoot = mkdtempSync(join(tmpdir(), 'panepilot-remote-start-'))
    const fakeBin = join(temporaryRoot, 'bin')
    mkdirSync(fakeBin)
    const fakeSsh = join(fakeBin, 'ssh')
    writeFileSync(
      fakeSsh,
      [
        '#!/bin/sh',
        'case "$*" in',
        '  *has-session*) sleep 0.15; exit 1 ;;',
        '  *panepilot_tmux*) sleep 0.15; printf "/usr/bin/tmux\\n"; exit 0 ;;',
        '  *) sleep 5 ;;',
        'esac'
      ].join('\n')
    )
    chmodSync(fakeSsh, 0o755)
    process.env.PATH = `${fakeBin}:${originalPath ?? ''}`
    process.env.SHELL = '/bin/sh'

    const appData = join(temporaryRoot, 'data')
    mkdirSync(appData)
    const store = new Store(appData)
    store.syncConnections(['slow-host'])
    const project = store.createProject({
      type: 'terminal',
      name: 'Remote project',
      connectionId: 'ssh:slow-host',
      folder: '/srv/project',
      repositoryUrl: null
    })
    const manager = new TerminalManager(
      store,
      () => null,
      new ConversationIndexer(),
      new RemoteConversationIndexer()
    )

    try {
      const startedAt = performance.now()
      const pendingSession = manager.start({
        projectId: project.id,
        profile: 'codex',
        dangerousMode: false
      })

      expect(performance.now() - startedAt).toBeLessThan(100)
      const session = await pendingSession
      expect(session).toMatchObject({
        projectId: project.id,
        profile: 'codex',
        backend: 'tmux'
      })
    } finally {
      manager.shutdown()
      store.close()
    }
  })
})
