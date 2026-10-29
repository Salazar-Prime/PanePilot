import { execFile, execFileSync } from 'node:child_process'
import type {
  Connection,
  GitBranchRef,
  GitChangeKind,
  GitCommit,
  GitCommitPage,
  GitFileChange,
  GitHubRepositoryVisibility,
  GitHubRepositoryVisibilityStatus,
  GitRepositoryStatus,
  Project
} from '../shared/types'
import { parseGitHubRepositoryReference, type GitHubRepositoryReference } from '../shared/git'
import type { Store } from './store'

export { parseGitHubRepositoryReference } from '../shared/git'

const GIT_TIMEOUT_MS = 12_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_COMMIT_LIMIT = 80
const MAX_COMMIT_LIMIT = 120
const LOG_RECORD = '\x1e'
const LOG_FIELD = '\x1f'
const GITHUB_VISIBILITY_CACHE_MS = 5 * 60 * 1_000
const GITHUB_API_TIMEOUT_MS = 8_000
const REPOSITORY_METADATA_CACHE_MS = 30_000
const MAX_CACHED_REPOSITORIES = 64

export interface GitHubVisibilityResolver {
  resolve(reference: GitHubRepositoryReference): Promise<{
    visibility: GitHubRepositoryVisibility
    source: 'gh' | 'public-api'
  } | null>
}

function normalizeGitHubVisibility(
  value: unknown
): GitHubRepositoryVisibility | null {
  const normalized = String(value ?? '').trim().toLocaleLowerCase()
  return normalized === 'public' ||
    normalized === 'private' ||
    normalized === 'internal'
    ? normalized
    : null
}

const defaultGitHubVisibilityResolver: GitHubVisibilityResolver = {
  async resolve(reference) {
    try {
      const raw = await execute(
        'gh',
        [
          'repo',
          'view',
          reference.nameWithOwner,
          '--json',
          'visibility',
          '--jq',
          '.visibility'
        ],
        GITHUB_API_TIMEOUT_MS
      )
      const visibility = normalizeGitHubVisibility(raw)
      if (visibility) return { visibility, source: 'gh' }
    } catch {
      // The public REST endpoint below still works when gh is absent or signed out.
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS)
    try {
      const response = await fetch(
        `https://api.github.com/repos/${reference.nameWithOwner}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'PanePilot',
            'X-GitHub-Api-Version': '2022-11-28'
          },
          signal: controller.signal
        }
      )
      if (!response.ok) return null
      const body = (await response.json()) as {
        visibility?: unknown
        private?: unknown
      }
      const visibility =
        normalizeGitHubVisibility(body.visibility) ??
        (typeof body.private === 'boolean'
          ? body.private
            ? 'private'
            : 'public'
          : null)
      return visibility ? { visibility, source: 'public-api' } : null
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}

export function discoverRepository(folder: string): string | null {
  try {
    const raw = execFileSync('git', ['-C', folder, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!raw) return null
    const sshMatch = raw.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
    if (sshMatch) return `https://${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, '')}`
    return raw.replace(/\.git$/, '')
  } catch {
    return null
  }
}

interface GitRunner {
  run(args: string[]): Promise<string>
}

class GitCommandError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: number | string
  ) {
    super(message)
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function gitRemoteCommand(folder: string, args: string[]): string {
  return ['git', '--no-optional-locks', '-C', folder, ...args]
    .map(shellQuote)
    .join(' ')
}

function execute(
  executable: string,
  args: string[],
  timeout = GIT_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }
        const detail = String(stderr ?? '').trim()
        const message =
          'killed' in error && error.killed
            ? 'Git took too long to respond.'
            : detail.split(/\r?\n/).at(-1) || error.message
        reject(new GitCommandError(message, detail, error.code ?? undefined))
      }
    )
  })
}

function runnerFor(project: Project, connection: Connection): GitRunner {
  if (connection.kind === 'local') {
    return {
      run: (args) =>
        execute('git', ['--no-optional-locks', '-C', project.folder, ...args])
    }
  }
  const alias = connection.sshAlias ?? connection.name
  return {
    run: (args) =>
      execute('ssh', [
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=5',
        alias,
        gitRemoteCommand(project.folder, args)
      ])
  }
}

function changeKind(code: string): GitChangeKind | null {
  switch (code) {
    case 'A':
      return 'added'
    case 'C':
      return 'copied'
    case 'D':
      return 'deleted'
    case 'M':
      return 'modified'
    case 'R':
      return 'renamed'
    case 'T':
      return 'type-changed'
    case 'U':
      return 'unmerged'
    default:
      return null
  }
}

function pathAfterFields(record: string, fieldCount: number): string {
  let offset = 0
  for (let index = 0; index < fieldCount; index += 1) {
    offset = record.indexOf(' ', offset)
    if (offset < 0) return ''
    offset += 1
  }
  return record.slice(offset)
}

function isConflictStatus(recordType: string, xy: string): boolean {
  return (
    recordType === 'u' ||
    xy.includes('U') ||
    ['AA', 'DD', 'AU', 'UA', 'DU', 'UD'].includes(xy)
  )
}

interface ParsedGitStatus {
  branch: string | null
  detached: boolean
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  stashCount: number
  changes: GitFileChange[]
}

export function parseGitPorcelainV2(raw: string): ParsedGitStatus {
  let branch: string | null = null
  let detached = false
  let head: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let stashCount = 0
  const changes: GitFileChange[] = []
  const records = raw.split('\0').filter(Boolean)

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record.startsWith('# branch.oid ')) {
      const value = record.slice('# branch.oid '.length)
      head = value === '(initial)' ? null : value
      continue
    }
    if (record.startsWith('# branch.head ')) {
      const value = record.slice('# branch.head '.length)
      detached = value === '(detached)'
      branch = detached ? null : value
      continue
    }
    if (record.startsWith('# branch.upstream ')) {
      upstream = record.slice('# branch.upstream '.length)
      continue
    }
    if (record.startsWith('# branch.ab ')) {
      const match = record.match(/\+(\d+)\s+-(\d+)/)
      ahead = Number(match?.[1] ?? 0)
      behind = Number(match?.[2] ?? 0)
      continue
    }
    if (record.startsWith('# stash ')) {
      stashCount = Number(record.slice('# stash '.length)) || 0
      continue
    }
    if (record.startsWith('? ')) {
      changes.push({
        path: record.slice(2),
        previousPath: null,
        staged: null,
        workingTree: null,
        untracked: true,
        conflicted: false
      })
      continue
    }

    const recordType = record[0]
    if (!['1', '2', 'u'].includes(recordType)) continue
    const xy = record.slice(2, 4)
    const conflicted = isConflictStatus(recordType, xy)
    const submoduleState = record.split(' ', 3)[2] ?? 'N...'
    const path = pathAfterFields(
      record,
      recordType === '1' ? 8 : recordType === '2' ? 9 : 10
    )
    const previousPath = recordType === '2' ? records[++index] ?? null : null
    const staged = conflicted ? 'unmerged' : changeKind(xy[0])
    let workingTree = conflicted ? 'unmerged' : changeKind(xy[1])
    if (
      !staged &&
      !workingTree &&
      submoduleState.startsWith('S') &&
      /[^.]/.test(submoduleState.slice(1))
    ) {
      workingTree = 'modified'
    }
    changes.push({
      path,
      previousPath,
      staged,
      workingTree,
      untracked: false,
      conflicted
    })
  }

  return {
    branch,
    detached,
    head,
    upstream,
    ahead,
    behind,
    stashCount,
    changes
  }
}

export function parseGitGraph(raw: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const line of raw.split(/\r?\n/)) {
    const recordOffset = line.indexOf(LOG_RECORD)
    if (recordOffset < 0) continue
    const fields = line.slice(recordOffset + 1).split(LOG_FIELD)
    if (fields.length < 7 || !fields[0]) continue
    commits.push({
      hash: fields[0],
      shortHash: fields[1],
      parents: fields[2] ? fields[2].split(' ') : [],
      decorations: fields[3]
        ? fields[3].split(', ').map((item) => item.trim()).filter(Boolean)
        : [],
      author: fields[4],
      authoredAt: fields[5],
      subject: fields.slice(6).join(LOG_FIELD),
      graph: line.slice(0, recordOffset).trimEnd() || '*'
    })
  }
  return commits
}

export function parseGitBranches(raw: string): GitBranchRef[] {
  const branches: GitBranchRef[] = []
  for (const record of raw.split(/\r?\n/)) {
    const [refname, hash] = record.split('\0')
    if (!refname || !/^[a-f0-9]{40,64}$/i.test(hash ?? '')) continue
    const remote = refname.startsWith('refs/remotes/')
    const prefix = remote ? 'refs/remotes/' : 'refs/heads/'
    if (!refname.startsWith(prefix)) continue
    const name = refname.slice(prefix.length)
    if (!name || (remote && name.endsWith('/HEAD'))) continue
    branches.push({ name, hash, remote })
  }
  return branches.sort((a, b) =>
    Number(a.remote) - Number(b.remote) || a.name.localeCompare(b.name)
  )
}

function isNotRepository(error: unknown): boolean {
  const detail =
    error instanceof GitCommandError
      ? `${error.message}\n${error.stderr}`
      : error instanceof Error
        ? error.message
        : String(error)
  return /not a git repository|not a repository/i.test(detail)
}

function unavailableStatus(message: string): GitRepositoryStatus {
  return {
    isRepository: false,
    root: null,
    originUrl: null,
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    stashCount: 0,
    clean: false,
    changes: [],
    message,
    refreshedAt: new Date().toISOString()
  }
}

interface RepositoryMetadata {
  root: string
  originUrl: string | null
}

function repositoryLocationKey(project: Project, connection: Connection): string {
  return JSON.stringify([
    connection.kind,
    connection.kind === 'ssh' ? connection.sshAlias ?? connection.name : '',
    project.folder
  ])
}

function sharePendingRead<T>(
  pending: Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>
): Promise<T> {
  const existing = pending.get(key)
  if (existing) return existing
  const result = read()
  pending.set(key, result)
  const clear = (): void => {
    if (pending.get(key) === result) pending.delete(key)
  }
  void result.then(clear, clear)
  return result
}

function retainCachedRead<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHED_REPOSITORIES) {
    cache.delete(cache.keys().next().value!)
  }
}

export class GitService {
  private readonly visibilityCache = new Map<
    string,
    { expiresAt: number; status: GitHubRepositoryVisibilityStatus }
  >()
  private readonly pendingVisibility = new Map<string, Promise<GitHubRepositoryVisibilityStatus>>()
  private readonly metadataCache = new Map<
    string,
    { expiresAt: number; metadata: RepositoryMetadata }
  >()
  private readonly pendingMetadata = new Map<string, Promise<RepositoryMetadata>>()
  private readonly pendingStatus = new Map<string, Promise<GitRepositoryStatus>>()

  constructor(
    private readonly store: Store,
    private readonly githubVisibility: GitHubVisibilityResolver =
      defaultGitHubVisibilityResolver
  ) {}

  async repositoryVisibility(
    projectId: string
  ): Promise<GitHubRepositoryVisibilityStatus> {
    const project = this.store.getProjectForRuntime(projectId)
    if (!project || project.archived) throw new Error('Project not found.')
    const reference = parseGitHubRepositoryReference(project.repositoryUrl)
    const checkedAt = new Date().toISOString()
    if (!reference) {
      return {
        repository: null,
        visibility: null,
        source: null,
        message: project.repositoryUrl
          ? 'The configured repository is not a GitHub repository.'
          : 'No GitHub repository is configured for this project.',
        checkedAt
      }
    }
    const cached = this.visibilityCache.get(reference.nameWithOwner)
    if (cached && cached.expiresAt > Date.now()) {
      retainCachedRead(this.visibilityCache, reference.nameWithOwner, cached)
      return cached.status
    }
    this.visibilityCache.delete(reference.nameWithOwner)
    return sharePendingRead(this.pendingVisibility, reference.nameWithOwner, async () => {
      const resolved = await this.githubVisibility.resolve(reference)
      const status: GitHubRepositoryVisibilityStatus = {
        repository: reference.nameWithOwner,
        visibility: resolved?.visibility ?? null,
        source: resolved?.source ?? null,
        message: resolved
          ? null
          : 'Visibility unavailable. Sign in with GitHub CLI to identify private repositories.',
        checkedAt
      }
      retainCachedRead(this.visibilityCache, reference.nameWithOwner, {
        expiresAt: Date.now() + GITHUB_VISIBILITY_CACHE_MS,
        status
      })
      return status
    })
  }

  async status(projectId: string): Promise<GitRepositoryStatus> {
    const { project, connection, runner } = this.projectRunner(projectId)
    const key = repositoryLocationKey(project, connection)
    // Share only a live read. The next settled call must see working-tree changes.
    return sharePendingRead(this.pendingStatus, key, () => this.readStatus(key, runner))
  }

  private async repositoryMetadata(key: string, runner: GitRunner): Promise<RepositoryMetadata> {
    const cached = this.metadataCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      retainCachedRead(this.metadataCache, key, cached)
      return cached.metadata
    }
    this.metadataCache.delete(key)
    return sharePendingRead(this.pendingMetadata, key, async () => {
      let cacheable = true
      const [root, originUrl] = await Promise.all([
        runner.run(['rev-parse', '--show-toplevel']),
        runner.run(['config', '--get', 'remote.origin.url'])
          .then((value) => value.trim() || null)
          .catch((error: unknown) => {
            // Missing origin is normal. A transport/command failure must retry on
            // the next read instead of caching a false "Local" result for 30 s.
            cacheable = error instanceof GitCommandError && error.code === 1 && !error.stderr
            return null
          })
      ])
      const metadata = { root: root.trim(), originUrl }
      if (cacheable) {
        retainCachedRead(this.metadataCache, key, {
          expiresAt: Date.now() + REPOSITORY_METADATA_CACHE_MS,
          metadata
        })
      }
      return metadata
    })
  }

  private async readStatus(key: string, runner: GitRunner): Promise<GitRepositoryStatus> {
    try {
      // Let both bounded reads settle before invalidating failed metadata, so a
      // slower metadata request cannot repopulate the cache after that failure.
      const [metadataResult, statusResult] = await Promise.allSettled([
        this.repositoryMetadata(key, runner),
        runner.run([
          'status',
          '--porcelain=v2',
          '--branch',
          '--show-stash',
          '-z',
          '--untracked-files=all'
        ])
      ])
      if (metadataResult.status === 'rejected') throw metadataResult.reason
      if (statusResult.status === 'rejected') throw statusResult.reason
      const parsed = parseGitPorcelainV2(statusResult.value)
      return {
        isRepository: true,
        ...metadataResult.value,
        ...parsed,
        clean: parsed.changes.length === 0,
        message: null,
        refreshedAt: new Date().toISOString()
      }
    } catch (error) {
      this.metadataCache.delete(key)
      if (isNotRepository(error)) {
        return unavailableStatus('This project folder is not a Git repository.')
      }
      throw error
    }
  }

  async commits(
    projectId: string,
    requestedOffset = 0,
    requestedLimit = DEFAULT_COMMIT_LIMIT,
    requestedTipHash?: string
  ): Promise<GitCommitPage> {
    if (requestedTipHash != null && (typeof requestedTipHash !== 'string' || !/^[a-f0-9]{40,64}$/i.test(requestedTipHash))) {
      throw new Error('A branch filter requires an exact commit hash.')
    }
    const revisions = requestedTipHash ? [requestedTipHash] : ['--exclude=refs/stash', '--all']
    const offset = Number.isSafeInteger(requestedOffset)
      ? Math.max(0, requestedOffset)
      : 0
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(MAX_COMMIT_LIMIT, Math.max(1, requestedLimit))
      : DEFAULT_COMMIT_LIMIT
    const { runner } = this.projectRunner(projectId)
    let total: number
    try {
      total = Number((await runner.run(['rev-list', '--count', ...revisions])).trim()) || 0
    } catch (error) {
      if (isNotRepository(error)) {
        return { commits: [], offset, total: 0, hasMore: false }
      }
      throw error
    }
    if (total === 0 || offset >= total) {
      return { commits: [], offset, total, hasMore: false }
    }
    const raw = await runner.run([
      '--no-pager',
      'log',
      '--topo-order',
      '--graph',
      '--decorate=short',
      `--max-count=${limit}`,
      `--skip=${offset}`,
      `--format=${LOG_RECORD}%H${LOG_FIELD}%h${LOG_FIELD}%P${LOG_FIELD}%D${LOG_FIELD}%an${LOG_FIELD}%aI${LOG_FIELD}%s`,
      ...revisions
    ])
    const commits = parseGitGraph(raw)
    return {
      commits,
      offset,
      total,
      hasMore: offset + commits.length < total
    }
  }

  async branches(projectId: string): Promise<GitBranchRef[]> {
    const { runner } = this.projectRunner(projectId)
    try {
      return parseGitBranches(await runner.run([
        'for-each-ref',
        '--format=%(refname)%00%(objectname)',
        'refs/heads',
        'refs/remotes'
      ]))
    } catch (error) {
      if (isNotRepository(error)) return []
      throw error
    }
  }

  private projectRunner(projectId: string): {
    project: Project
    connection: Connection
    runner: GitRunner
  } {
    const project = this.store.getProjectForRuntime(projectId)
    if (!project || project.archived) throw new Error('Project not found.')
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return { project, connection, runner: runnerFor(project, connection) }
  }
}
