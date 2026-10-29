import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GitService, type GitHubVisibilityResolver } from '../src/main/git'
import type { Store } from '../src/main/store'
import type { Connection, Project } from '../src/shared/types'

const executeMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: executeMock
}))

interface Command {
  executable: string
  args: string[]
  kind: 'root' | 'origin' | 'status'
  folder: string
}
type Reply = string | { code: number | string; stderr: string }
type ReplyHandler = (command: Command) => Reply | Promise<Reply>
const commands: Command[] = []
const cleanStatus = '# branch.oid ' + 'a'.repeat(40) + '\0# branch.head main\0'
let reply: ReplyHandler

beforeEach(() => {
  commands.length = 0
  reply = (command) => command.kind === 'root'
    ? command.folder + '\n'
    : command.kind === 'origin'
      ? 'git@github.com:fixture/repository.git\n'
      : cleanStatus
  executeMock.mockImplementation((
    executable: string,
    args: string[],
    _options: unknown,
    callback: (error: (Error & { code: number | string }) | null, stdout: string, stderr: string) => void
  ) => {
    const raw = args.join(' ')
    const command: Command = {
      executable,
      args,
      kind: raw.includes('--show-toplevel') ? 'root' : raw.includes('remote.origin.url') ? 'origin' : 'status',
      folder: executable === 'git' ? args[2] : '/remote/fixture'
    }
    commands.push(command)
    void Promise.resolve().then(() => reply(command)).then((result) => {
      if (typeof result === 'string') callback(null, result, '')
      else callback(Object.assign(new Error('Fixture command failed'), { code: result.code }), '', result.stderr)
    })
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  executeMock.mockReset()
})

function fixture(resolver?: GitHubVisibilityResolver): {
  project: Project
  connection: Connection
  service: GitService
} {
  const project = {
    id: 'fixture-project', connectionId: 'fixture-connection', folder: '/projects/one',
    archived: false, repositoryUrl: 'https://github.com/fixture/repository'
  } as Project
  const connection = { id: 'fixture-connection', kind: 'local', name: 'Fixture', sshAlias: null } as Connection
  const store = {
    getProjectForRuntime: () => project,
    getConnection: () => connection
  } as unknown as Store
  return { project, connection, service: new GitService(store, resolver) }
}

function count(kind: Command['kind']): number {
  return commands.filter((command) => command.kind === kind).length
}

describe('bounded Git reads', () => {
  it('shares simultaneous status reads but reads fresh changes after settlement', async () => {
    const { service } = fixture()
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => service.status(`project-${index}`)))
    expect(count('root')).toBe(1)
    expect(count('origin')).toBe(1)
    expect(count('status')).toBe(1)
    expect(results.every((result) => result === results[0])).toBe(true)

    reply = () => cleanStatus + '? fresh.txt\0'
    expect((await service.status('project-0')).changes).toMatchObject([{ path: 'fresh.txt', untracked: true }])
    expect(count('status')).toBe(2)
    expect(count('root')).toBe(1)
    expect(count('origin')).toBe(1)
  })

  it('refreshes root and origin after thirty seconds without extending their TTL on access', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const { service } = fixture()
    await service.status('project')
    const originalReply = reply
    reply = (command) => command.kind === 'origin' ? 'git@github.com:fixture/new-origin.git\n' : originalReply(command)
    now += 29_999
    expect((await service.status('project')).originUrl).toBe('git@github.com:fixture/repository.git')
    expect(count('root')).toBe(1)
    now += 1
    expect((await service.status('project')).originUrl).toBe('git@github.com:fixture/new-origin.git')
    expect(count('root')).toBe(2)
    expect(count('origin')).toBe(2)
    expect(count('status')).toBe(3)
  })

  it('keys metadata by folder, connection kind, and effective SSH alias', async () => {
    const { project, connection, service } = fixture()
    await service.status(project.id)
    project.folder = '/projects/two'
    expect((await service.status(project.id)).root).toBe('/projects/two')
    connection.kind = 'ssh'
    connection.sshAlias = 'fixture-one'
    await service.status(project.id)
    connection.sshAlias = 'fixture-two'
    await service.status(project.id)
    connection.sshAlias = null
    connection.name = 'fixture-name-fallback'
    await service.status(project.id)
    expect(count('root')).toBe(5)
    expect(count('origin')).toBe(5)
    expect(commands.filter((command) => command.executable === 'ssh').every((command) => command.args.includes('-T'))).toBe(true)
    expect(commands.at(-1)?.args).toContain('fixture-name-fallback')
    // The fake exec implementation records commands; no SSH process is started.
  })

  it('keeps a reassigned project separate from its old in-flight read', async () => {
    const { project, service } = fixture()
    let finishOldRead!: (result: Reply) => void
    const originalReply = reply
    reply = (command) => command.kind === 'status' && command.folder === '/projects/one'
      ? new Promise<Reply>((resolve) => { finishOldRead = resolve })
      : originalReply(command)
    const oldRead = service.status(project.id)
    await Promise.resolve()
    project.folder = '/projects/two'
    expect((await service.status(project.id)).root).toBe('/projects/two')
    finishOldRead(cleanStatus)
    expect((await oldRead).root).toBe('/projects/one')
    expect((await service.status(project.id)).root).toBe('/projects/two')
    expect(count('root')).toBe(2)
    expect(count('status')).toBe(3)
  })

  it('invalidates metadata when a previously valid repository disappears', async () => {
    const { service } = fixture()
    const originalReply = reply
    await service.status('project')
    reply = () => ({ code: 128, stderr: 'fatal: not a git repository' })
    expect((await service.status('project')).isRepository).toBe(false)
    reply = originalReply
    expect((await service.status('project')).isRepository).toBe(true)
    expect(count('root')).toBe(2)
    expect(count('origin')).toBe(2)
  })

  it('retries transient origin failures instead of caching a false local result', async () => {
    const { service } = fixture()
    const originalReply = reply
    reply = (command) => command.kind === 'origin'
      ? { code: 255, stderr: 'ssh: fixture transport unavailable' }
      : originalReply(command)
    expect((await service.status('project')).originUrl).toBeNull()
    reply = originalReply
    expect((await service.status('project')).originUrl).toBe('git@github.com:fixture/repository.git')
    await service.status('project')
    expect(count('origin')).toBe(2)
    expect(count('root')).toBe(2)
  })

  it('caches a genuinely missing origin and releases failed status reads for retry', async () => {
    const { service } = fixture()
    const originalReply = reply
    reply = (command) => command.kind === 'origin' ? { code: 1, stderr: '' } : originalReply(command)
    expect((await service.status('project')).originUrl).toBeNull()
    await service.status('project')
    expect(count('origin')).toBe(1)
    reply = () => ({ code: 255, stderr: 'ssh: fixture transport unavailable' })
    const failures = await Promise.allSettled([service.status('project'), service.status('project')])
    expect(failures.every((result) => result.status === 'rejected')).toBe(true)
    expect(count('status')).toBe(3)
    reply = originalReply
    expect((await service.status('project')).isRepository).toBe(true)
    expect(count('root')).toBe(2)
    expect(count('origin')).toBe(2)
  })

  it('does not let late metadata repopulate the cache after a status failure', async () => {
    const { service } = fixture()
    let finishRootRead!: (result: Reply) => void
    const originalReply = reply
    reply = (command) => command.kind === 'root'
      ? new Promise<Reply>((resolve) => { finishRootRead = resolve })
      : command.kind === 'status'
        ? { code: 128, stderr: 'fatal: not a git repository' }
        : originalReply(command)
    const failingRead = service.status('project')
    await Promise.resolve()
    finishRootRead('/projects/one\n')
    expect((await failingRead).isRepository).toBe(false)
    reply = originalReply
    await service.status('project')
    expect(count('root')).toBe(2)
  })

  it('retains at most sixty-four metadata entries in least recently used order', async () => {
    const { project, service } = fixture()
    for (let index = 0; index < 64; index += 1) {
      project.folder = `/projects/${index}`
      await service.status(project.id)
    }
    project.folder = '/projects/0'
    await service.status(project.id)
    project.folder = '/projects/64'
    await service.status(project.id)
    project.folder = '/projects/0'
    await service.status(project.id)
    expect(count('root')).toBe(65)
    project.folder = '/projects/1'
    await service.status(project.id)
    expect(count('root')).toBe(66)
  })

  it('shares concurrent GitHub visibility reads and refreshes expired entries', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const resolve = vi.fn(async () => ({ visibility: 'private' as const, source: 'gh' as const }))
    const { service } = fixture({ resolve })
    const statuses = await Promise.all(Array.from({ length: 10 }, () => service.repositoryVisibility('project')))
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(statuses.every((status) => status.visibility === 'private')).toBe(true)
    now += 300_000
    await service.repositoryVisibility('project')
    expect(resolve).toHaveBeenCalledTimes(2)
  })

  it('bounds visibility entries and retries a rejected resolver', async () => {
    const resolve = vi.fn(async () => ({ visibility: 'private' as const, source: 'gh' as const }))
    const { project, service } = fixture({ resolve })
    resolve.mockRejectedValueOnce(new Error('Fixture resolver unavailable'))
    await expect(service.repositoryVisibility(project.id)).rejects.toThrow('Fixture resolver unavailable')
    for (let index = 0; index < 65; index += 1) {
      project.repositoryUrl = `https://github.com/fixture/repository-${index}`
      await service.repositoryVisibility(project.id)
    }
    project.repositoryUrl = 'https://github.com/fixture/repository-0'
    await service.repositoryVisibility(project.id)
    expect(resolve).toHaveBeenCalledTimes(67)
  })
})
