import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationIndexer } from '../src/main/conversation-indexer'
import { RemoteConversationIndexer } from '../src/main/remote-conversation-indexer'
import { Store } from '../src/main/store'
import { TerminalManager, type LatexInlineExecResult } from '../src/main/terminal-manager'

interface Internals {
  requireProjectTmux(id: string, capability: string): Promise<void>
  tmuxSessionExists(...args: unknown[]): Promise<boolean>
  runLatexInlineEditExecOnce(id: string, prompt: string): Promise<LatexInlineExecResult>
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const cleanups: Array<() => void> = []
beforeEach(() => { vi.stubEnv('SHELL', '/panepilot-async-fixture-no-shell') })
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'panepilot-async-lifecycle-'))
  const store = new Store(folder)
  store.syncConnections([])
  const project = store.createProject({ type: 'latex', name: 'Fixture paper', folder,
    connectionId: 'local', repositoryUrl: null,
    latex: { mainFile: 'main.tex', overleafUrl: null, contextFolder: 'context' } })
  const manager = new TerminalManager(store, () => null, new ConversationIndexer(), new RemoteConversationIndexer())
  cleanups.push(() => { manager.shutdown(); store.close(); rmSync(folder, { force: true, recursive: true }) })
  const internal = manager as unknown as Internals
  vi.spyOn(internal, 'requireProjectTmux').mockResolvedValue()
  return { project, store, manager, internal }
}

describe('asynchronous terminal lifecycle serialization', () => {
  it('creates one inline runner when two panes request it during a slow availability read', async () => {
    const f = fixture()
    const check = deferred<boolean>()
    const exists = vi.spyOn(f.internal, 'tmuxSessionExists').mockReturnValue(check.promise)
    const first = f.manager.startLatexInlineChat(f.project.id)
    const second = f.manager.startLatexInlineChat(f.project.id)
    await vi.waitFor(() => expect(exists).toHaveBeenCalledOnce())
    check.resolve(false)
    const [a, b] = await Promise.all([first, second])
    expect(a.id).toBe(b.id)
    expect(f.store.getProjectForRuntime(f.project.id)?.sessions).toHaveLength(1)
    expect(a.latexChat?.purpose).toBe('inline-edit')
  })

  it('does not persist an inline runner after shutdown during its name check', async () => {
    const f = fixture()
    const check = deferred<boolean>()
    const exists = vi.spyOn(f.internal, 'tmuxSessionExists').mockReturnValue(check.promise)
    const pending = f.manager.startLatexInlineChat(f.project.id)
    await vi.waitFor(() => expect(exists).toHaveBeenCalledOnce())
    f.manager.shutdown()
    check.resolve(false)
    await expect(pending).rejects.toThrow('closing')
    expect(f.store.getProjectForRuntime(f.project.id)?.sessions).toHaveLength(0)
  })

  it('rejects a second inline turn while the first asynchronous preparation is pending', async () => {
    const f = fixture()
    const result = deferred<LatexInlineExecResult>()
    const run = vi.spyOn(f.internal, 'runLatexInlineEditExecOnce').mockReturnValue(result.promise)
    const pending = f.manager.runLatexInlineEditExec('exact-runner', 'first instruction')
    await expect(f.manager.runLatexInlineEditExec('exact-runner', 'second instruction')).rejects.toThrow('Wait for the current inline edit')
    expect(run).toHaveBeenCalledOnce()
    result.resolve({ exitCode: 0, output: 'done' })
    await expect(pending).resolves.toEqual({ exitCode: 0, output: 'done' })
    await f.manager.runLatexInlineEditExec('exact-runner', 'later instruction')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
