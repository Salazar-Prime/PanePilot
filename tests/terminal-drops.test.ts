import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, readdir, rm, symlink, open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { MAX_DROP_BYTES, RECEIVE_DROP_SCRIPT, streamRemoteDrop, TerminalDropService } from '../src/main/terminal-drop-service'
import { droppedPathsText, type TerminalDropProgress } from '../src/shared/terminalDrops'
import type { Store } from '../src/main/store'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'panepilot-drops-test-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function store(remote = true) {
  return {
    getSession: () => ({ id: 'session', projectId: 'project', state: 'idle', archived: false }),
    getProjectForRuntime: () => ({ id: 'project', name: 'Paper', folder: root, connectionId: 'machine', archived: false }),
    getConnection: () => ({ kind: remote ? 'ssh' : 'local', name: 'Remote', sshAlias: 'test-host' })
  } as unknown as Pick<Store, 'getSession' | 'getProjectForRuntime' | 'getConnection'>
}

function receive(name: string, data: Buffer, size = data.length, id = randomUUID()) {
  const result = spawnSync('python3', ['-c', RECEIVE_DROP_SCRIPT], {
    input: Buffer.concat([Buffer.from(JSON.stringify({ root, name, size, id }) + '\n'), data]),
    encoding: 'utf8', timeout: 10_000
  })
  return { ...result, id }
}

describe('remote dropped-asset receiver', () => {
  it('streams through the production transport, using a local Python receiver instead of SSH', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
    vi.mocked(spawn).mockImplementationOnce(((_command: string, _args: unknown, options?: SpawnOptions) =>
      actual.spawn('python3', ['-c', RECEIVE_DROP_SCRIPT], options ?? {})) as unknown as typeof spawn)
    const path = join(root, 'source.bin')
    const data = Buffer.alloc(2 * 1024 * 1024, 215)
    await writeFile(path, data)
    const file = await open(path, 'r')
    const progress = vi.fn()
    try {
      const remotePath = await streamRemoteDrop('host', root, 'remote.bin', data.length, file, new AbortController().signal, progress)
      expect(await readFile(remotePath)).toEqual(data)
      expect(progress).toHaveBeenLastCalledWith(data.length)
    } finally { await file.close() }
  })

  it('writes exact binary bytes into unique project metadata folders and acknowledges progress', async () => {
    const data = Buffer.alloc(700_000, 173)
    const first = receive("a 'picture'.png", data)
    const second = receive("a 'picture'.png", Buffer.from('second'))
    expect(first.status, first.stderr).toBe(0)
    expect(second.status, second.stderr).toBe(0)
    const events = first.stdout.trim().split('\n').map((line) => JSON.parse(line))
    expect(events[0].bytes).toBeGreaterThan(0)
    expect(events.at(-1).bytes).toBe(data.length)
    expect(await readFile(events.at(-1).path)).toEqual(data)
    expect(second.stdout).not.toContain(first.id)
  })

  it('cleans partial files on premature EOF', async () => {
    const result = receive('image.png', Buffer.from('short'), 100)
    expect(result.status).not.toBe(0)
    expect(await readdir(join(root, '.panepilot', 'dropped-assets'))).toEqual([])
  })

  it.each(['.panepilot', 'dropped-assets'])('rejects a symlink at %s', async (part) => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    if (part === 'dropped-assets') await mkdir(join(root, '.panepilot'))
    await symlink(outside, part === '.panepilot' ? join(root, part) : join(root, '.panepilot', part))
    expect(receive('image.png', Buffer.from('image')).status).not.toBe(0)
    expect(await readdir(outside)).toEqual([])
  })

  it('rejects traversal and refuses to overwrite an existing upload', async () => {
    expect(receive('../escape', Buffer.from('unsafe')).status).not.toBe(0)
    const first = receive('file', Buffer.from('original'))
    const second = receive('file', Buffer.from('changed'), 7, first.id)
    expect(second.status).not.toBe(0)
    expect(await readFile(join(root, '.panepilot', 'dropped-assets', first.id, 'file'), 'utf8')).toBe('original')
  })
})

describe('terminal drop routing and progress', () => {
  it('keeps local files in place and returns their paths without uploading', async () => {
    const path = join(root, 'image.png')
    await writeFile(path, 'local')
    const upload = vi.fn()
    const service = new TerminalDropService(store(false), vi.fn(), upload)
    const result = await service.drop('session', [path])
    expect(result.paths[0]).toMatch(/image\.png$/)
    expect(upload).not.toHaveBeenCalled()
    expect(await readdir(root)).toEqual(['image.png'])
  })

  it('reports remote byte counts and preserves successful paths when a later file fails', async () => {
    const paths = [join(root, 'one'), join(root, 'two')]
    await Promise.all(paths.map((path) => writeFile(path, 'data')))
    const events: TerminalDropProgress[] = []
    const service = new TerminalDropService(store(), (event) => events.push(event), async (_alias, _root, name, size, _file, _signal, progress) => {
      if (name === 'two') throw new Error('Lost connection')
      progress(size)
      return '/project/.panepilot/dropped-assets/unique/one'
    })
    const result = await service.drop('session', paths)
    expect(result.paths).toHaveLength(1)
    expect(result.error).toBe('Lost connection')
    expect(events.at(-1)).toMatchObject({ state: 'failed', sessionId: 'session', completedFiles: 1, transferredBytes: 4, totalBytes: 8 })
    expect(events[0].paths).toEqual([]) // progress snapshots do not mutate later
  })

  it('marks completion only after the remote receiver acknowledges the file', async () => {
    const path = join(root, 'empty')
    await writeFile(path, '')
    const events: TerminalDropProgress[] = []
    const service = new TerminalDropService(store(), (event) => events.push(event), async () => '/remote/empty')
    expect((await service.drop('session', [path])).paths).toEqual(['/remote/empty'])
    expect(events.at(-1)).toMatchObject({ state: 'completed', completedFiles: 1, totalFiles: 1 })
  })

  it('rejects directories, symlinks, excessive batches, and oversized files before upload', async () => {
    const upload = vi.fn()
    const service = new TerminalDropService(store(), vi.fn(), upload)
    await expect(service.drop('session', [root])).rejects.toThrow('not folders')
    const path = join(root, 'big')
    const handle = await open(path, 'w')
    await handle.truncate(MAX_DROP_BYTES + 1)
    await handle.close()
    await expect(service.drop('session', [path])).rejects.toThrow('1 GB')
    await symlink(path, join(root, 'link'))
    await expect(service.drop('session', [join(root, 'link')])).rejects.toThrow()
    await expect(service.drop('session', Array(21).fill(path))).rejects.toThrow('20 files')
    expect(upload).not.toHaveBeenCalled()
  })

  it('rejects ended or missing target sessions', async () => {
    const missing = { ...store(), getSession: () => null }
    await expect(new TerminalDropService(missing, vi.fn()).drop('missing', [join(root, 'file')])).rejects.toThrow('no longer available')
  })

  it('aborts in-flight work on shutdown and reports a failed batch without paths', async () => {
    const path = join(root, 'file')
    await writeFile(path, 'data')
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    const service = new TerminalDropService(store(), vi.fn(), async (_alias, _root, _name, _size, _file, signal) => {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })
        started()
      })
    })
    const pending = service.drop('session', [path])
    await ready
    service.shutdown()
    expect(await pending).toMatchObject({ paths: [], error: 'Upload timed out or was cancelled.' })
  })
})

describe('dropped path paste safety', () => {
  it('quotes spaces, quotes, and shell substitutions without submitting a command', () => {
    expect(droppedPathsText(["/tmp/a 'b'.png", '/tmp/$(touch bad).txt'])).toBe("'/tmp/a '\\''b'\\''.png' '/tmp/$(touch bad).txt' ")
    expect(droppedPathsText([])).toBe('')
  })
  it.each(['\n', '\r', '\x1b', '\0'])('rejects terminal control characters', (control) => {
    expect(() => droppedPathsText([`/tmp/file${control}.png`])).toThrow('control characters')
  })
})
