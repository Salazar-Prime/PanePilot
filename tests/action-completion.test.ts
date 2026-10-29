import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager } from '../src/main/terminal-manager'
import { LATEX_INLINE_OUTPUT_END, LATEX_INLINE_OUTPUT_START } from '../src/shared/latex-inline-edit'
import type { Connection, TerminalSession } from '../src/shared/types'

interface FixtureRuntime {
  session: TerminalSession
  connection: Connection
  outputClosed: boolean
  intentionalStop: boolean
  actionTimer: NodeJS.Timeout | null
  pty: { write: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> }
  screen: { dispose: ReturnType<typeof vi.fn> }
}

interface Internals {
  tmuxPath: string
  remoteTmuxPaths: Map<string, string>
  runtimes: Map<string, FixtureRuntime>
  readActionPaneSnapshot(runtime: FixtureRuntime): Promise<{ exitCode: number; output: string } | null>
  finishActionWhenPaneExits(runtime: FixtureRuntime): Promise<void>
  retainTerminalOutput(session: TerminalSession, data: string): void
  killTmuxSession(connection: Connection, name: string): void
  resolveLatexInlineExec(sessionId: string, result: { exitCode: number; output: string }): void
}

describe('Action completion with isolated tmux and SSH fixtures', () => {
  let root: string | null = null
  let store: Store | null = null
  let manager: TerminalManager | null = null

  afterEach(() => {
    manager?.shutdown()
    store?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    if (root) rmSync(root, { recursive: true, force: true })
    root = null
    store = null
    manager = null
  })

  function fixture(kind: 'local' | 'ssh' = 'ssh', inline = false) {
    root = mkdtempSync(join(tmpdir(), 'panepilot-action-completion-'))
    const bin = join(root, 'bin')
    mkdirSync(bin)
    const tmux = join(bin, "fake tmux's executable")
    writeFileSync(tmux, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.PANEPILOT_ACTION_FIXTURE;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls'), JSON.stringify(args) + '\\n');
if (args[0] === 'display-message') {
  if (fs.existsSync(path.join(root, 'state-error'))) process.exit(1);
  process.stdout.write(fs.readFileSync(path.join(root, 'state')));
} else if (args[0] === 'capture-pane') {
  if (fs.existsSync(path.join(root, 'capture-error'))) process.exit(1);
  process.stdout.write(fs.readFileSync(path.join(root, 'output')));
} else process.exit(1);
`)
    chmodSync(tmux, 0o755)
    const ssh = join(bin, 'ssh')
    writeFileSync(ssh, `#!/bin/sh
for argument do command="$argument"; done
printf '%s\\n' "$command" >> "$PANEPILOT_ACTION_FIXTURE/ssh-calls"
case "$command" in
  *capture-pane*) test ! -f "$PANEPILOT_ACTION_FIXTURE/ssh-capture-error" || exit 255 ;;
esac
exec /bin/sh -c "$command"
`)
    chmodSync(ssh, 0o755)
    writeFileSync(join(root, 'state'), ':0:\n')
    writeFileSync(join(root, 'output'), 'final output\n')
    writeFileSync(join(root, 'calls'), '')
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
    vi.stubEnv('PANEPILOT_ACTION_FIXTURE', root)
    vi.stubEnv('SHELL', '/bin/sh')
    store = new Store(root)
    store.syncConnections(['fixture-host'])
    const project = store.createProject({
      type: inline ? 'latex' : 'terminal',
      name: 'Completion fixture',
      connectionId: kind === 'local' ? 'local' : 'ssh:fixture-host',
      folder: root,
      repositoryUrl: null,
      ...(inline ? { latex: { mainFile: 'main.tex', overleafUrl: null, contextFolder: 'context' } } : {})
    })
    let session = store.createSession({
      projectId: project.id,
      kind: inline ? 'latex-chat' : 'action',
      name: "Action's exact name 🚀",
      profile: inline ? 'codex' : 'custom',
      providerSessionName: null,
      customCommand: 'fixture command',
      backend: 'tmux',
      tmuxName: "Action's exact name 🚀",
      dangerousMode: false
    })
    if (inline) {
      store.attachLatexChat(session.id, {
        projectId: project.id, purpose: 'inline-edit', scope: 'project', sectionId: null, mode: 'edit'
      })
      session = store.getSessionWithoutOutput(session.id)!
    }
    manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
    const internals = manager as unknown as Internals
    internals.tmuxPath = tmux
    internals.remoteTmuxPaths.set('ssh:fixture-host', tmux)
    const runtime: FixtureRuntime = {
      session,
      connection: store.getConnection(project.connectionId)!,
      outputClosed: false,
      intentionalStop: false,
      actionTimer: null,
      pty: { write: vi.fn(), kill: vi.fn() },
      screen: { dispose: vi.fn() }
    }
    internals.runtimes.set(session.id, runtime)
    const kill = vi.spyOn(internals, 'killTmuxSession').mockImplementation(() => {})
    return {
      store, manager, internals, runtime, kill,
      set(name: string, value: string) { writeFileSync(join(root!, name), value) },
      calls(): string[][] {
        return readFileSync(join(root!, 'calls'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
      }
    }
  }

  it.each(['local', 'ssh'] as const)('polls %s status without capturing running output or blocking terminal input', async (kind) => {
    const f = fixture(kind)
    for (let index = 0; index < 3; index += 1) {
      expect(await f.internals.readActionPaneSnapshot(f.runtime)).toBeNull()
      f.manager.write(f.runtime.session.id, `input ${index}\n`)
    }
    expect(f.calls().map((args) => args[0])).toEqual(['display-message', 'display-message', 'display-message'])
    expect(f.calls().every((args) => args[3] === `=${f.runtime.session.tmuxName}:`)).toBe(true)
    expect(f.runtime.pty.write.mock.calls).toEqual([['input 0\n'], ['input 1\n'], ['input 2\n']])
    expect(f.kill).not.toHaveBeenCalled()
  })

  it.each(['local', 'ssh'] as const)('completes %s Actions with oversized history, preserving the final output and exact target', async (kind) => {
    const f = fixture(kind)
    f.set('state', '0:0:\n')
    f.set('output', `${'🙂'.repeat(600_000)}final line\n`)
    const snapshot = await f.internals.readActionPaneSnapshot(f.runtime)
    expect(snapshot?.exitCode).toBe(0)
    expect(snapshot?.output.endsWith('final line\r\n')).toBe(true)
    expect(snapshot?.output).not.toContain('\ufffd')
    expect(Buffer.byteLength(snapshot!.output)).toBeLessThanOrEqual(1024 * 1024 + 1)
    await f.internals.finishActionWhenPaneExits(f.runtime)
    expect(f.store.getSession(f.runtime.session.id)).toMatchObject({ state: 'completed' })
    expect(f.store.getSession(f.runtime.session.id)?.output.endsWith('final line\r\n')).toBe(true)
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(f.runtime.connection, f.runtime.session.tmuxName)
    expect(f.runtime.pty.kill).toHaveBeenCalledOnce()
    expect(f.runtime.actionTimer).toBeNull()
    expect(f.calls().filter((args) => args[0] === 'capture-pane').every((args) => args.at(-1) === `=${f.runtime.session.tmuxName}:`)).toBe(true)
  })

  it.each(['capture-error', 'ssh-capture-error'])('completes after %s and retains streamed output', async (failure) => {
    const f = fixture()
    f.set('state', ':1:7\n')
    f.set(failure, '')
    f.internals.retainTerminalOutput(f.runtime.session, 'streamed final output\r\n')
    await f.internals.finishActionWhenPaneExits(f.runtime)
    expect(f.store.getSession(f.runtime.session.id)).toMatchObject({ state: 'error', output: 'streamed final output\r\n' })
    expect(f.kill).toHaveBeenCalledExactlyOnceWith(f.runtime.connection, f.runtime.session.tmuxName)
    expect(f.runtime.actionTimer).toBeNull()
  })

  it.each([':0:\n', 'invalid\n'])('does not finish from an absent or malformed exit marker: %j', async (state) => {
    const f = fixture()
    f.set('state', state)
    await f.internals.finishActionWhenPaneExits(f.runtime)
    expect(f.kill).not.toHaveBeenCalled()
    expect(f.runtime.actionTimer).not.toBeNull()
    expect(f.calls().map((args) => args[0])).toEqual(['display-message'])
  })

  it('keeps a failed status read retryable instead of declaring completion', async () => {
    const f = fixture()
    f.set('state-error', '')
    await f.internals.finishActionWhenPaneExits(f.runtime)
    expect(f.kill).not.toHaveBeenCalled()
    expect(f.runtime.actionTimer).not.toBeNull()
  })

  it.each([false, true])('preserves inline-edit result markers and volatile replay when capture fails: %s', async (captureFails) => {
    const f = fixture('ssh', true)
    const output = `${LATEX_INLINE_OUTPUT_START}${Buffer.from('model note 🙂').toString('base64')}${LATEX_INLINE_OUTPUT_END}`
    const resolve = vi.spyOn(f.internals, 'resolveLatexInlineExec')
    f.set('state', '0:0:\n')
    f.set('output', output)
    if (captureFails) f.set('ssh-capture-error', '')
    f.internals.retainTerminalOutput(f.runtime.session, output)
    await f.internals.finishActionWhenPaneExits(f.runtime)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(f.runtime.session.id, { exitCode: 0, output })
    expect(f.store.getSession(f.runtime.session.id)).toMatchObject({ state: 'response-ready', output: '' })
    expect((await f.manager.attach(f.runtime.session.id, 80, 24)).output).toBe(output)
    expect(f.kill).not.toHaveBeenCalled()
  })
})
