import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'

describe('terminal agent force reload', () => {
  let appDataPath: string | null = null
  let tmuxDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    if (tmuxDataPath) rmSync(tmuxDataPath, { recursive: true, force: true })
    appDataPath = null
    tmuxDataPath = null
  })

  it.skipIf(spawnSync('tmux', ['-V']).status !== 0)(
    'recreates the exact tmux session and resumes the stored provider chat',
    async () => {
      appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-force-reload-'))
      const store = new Store(appDataPath)
      store.syncConnections([])
      const folder = join(appDataPath, 'project')
      const binFolder = join(appDataPath, 'bin')
      tmuxDataPath = mkdtempSync('/tmp/panepilot-force-tmux-')
      const argsFile = join(appDataPath, 'codex-args.txt')
      mkdirSync(folder)
      mkdirSync(binFolder)
      const fakeCodex = join(binFolder, 'codex')
      writeFileSync(
        fakeCodex,
        '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$PANEPILOT_TEST_AGENT_ARGS"\nwhile :; do sleep 1; done\n'
      )
      chmodSync(fakeCodex, 0o755)

      const originalPath = process.env.PATH
      const originalShell = process.env.SHELL
      const originalTmux = process.env.TMUX
      const originalTmuxPane = process.env.TMUX_PANE
      const originalTmuxTmpdir = process.env.TMUX_TMPDIR
      const originalArgsFile = process.env.PANEPILOT_TEST_AGENT_ARGS
      process.env.PATH = `${binFolder}:${originalPath ?? ''}`
      delete process.env.SHELL
      delete process.env.TMUX
      delete process.env.TMUX_PANE
      process.env.TMUX_TMPDIR = tmuxDataPath
      process.env.PANEPILOT_TEST_AGENT_ARGS = argsFile

      const project = store.createProject({
        type: 'terminal',
        name: 'Project',
        connectionId: 'local',
        folder,
        repositoryUrl: null
      })
      const tmuxName = `Force reload ${randomUUID()}`
      const session = store.createSession({
        projectId: project.id,
        name: tmuxName,
        profile: 'codex',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName,
        dangerousMode: true
      })
      const threadId = randomUUID()
      store.setSessionProviderId(session.id, 'codex', threadId)

      expect(
        spawnSync('tmux', [
          'new-session',
          '-d',
          '-s',
          tmuxName,
          'while :; do sleep 60; done'
        ]).status
      ).toBe(0)

      const manager = new TerminalManager(
        store,
        () => null,
        new ConversationIndexer(),
        new RemoteConversationIndexer()
      )

      try {
        manager.forceReloadAgent(session.id)

        for (let attempt = 0; attempt < 50 && !existsSync(argsFile); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20))
        }

        expect(existsSync(argsFile)).toBe(true)
        const args = readFileSync(argsFile, 'utf8').trim().split('\n')
        expect(args).toContain('resume')
        expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
        expect(args).toContain(threadId)
        expect(store.getSession(session.id)?.state).toBe('idle')
        expect(
          spawnSync('tmux', ['has-session', '-t', `=${tmuxName}`]).status
        ).toBe(0)
      } finally {
        if (store.getSession(session.id)) manager.delete(session.id)
        manager.shutdown()
        store.close()
        if (originalPath == null) delete process.env.PATH
        else process.env.PATH = originalPath
        if (originalShell == null) delete process.env.SHELL
        else process.env.SHELL = originalShell
        if (originalTmux == null) delete process.env.TMUX
        else process.env.TMUX = originalTmux
        if (originalTmuxPane == null) delete process.env.TMUX_PANE
        else process.env.TMUX_PANE = originalTmuxPane
        if (originalTmuxTmpdir == null) delete process.env.TMUX_TMPDIR
        else process.env.TMUX_TMPDIR = originalTmuxTmpdir
        if (originalArgsFile == null) delete process.env.PANEPILOT_TEST_AGENT_ARGS
        else process.env.PANEPILOT_TEST_AGENT_ARGS = originalArgsFile
      }
    }
  )
})
