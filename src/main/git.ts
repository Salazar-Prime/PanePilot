import { execFile, execFileSync } from 'node:child_process'
import type {
  Connection,
  GitChangeKind,
  GitCommit,
  GitCommitPage,
  GitFileChange,
  GitHubRepositoryVisibility,
  GitHubRepositoryVisibilityStatus,
  GitRepositoryStatus,
  Project
} from '../shared/types'
import type { Store } from './store'

const GIT_TIMEOUT_MS = 12_000
const GIT_MAX_BUFFER = 8 * 1024 * 1024
const DEFAULT_COMMIT_LIMIT = 80
const MAX_COMMIT_LIMIT = 120
const LOG_RECORD = '\x1e'
const LOG_FIELD = '\x1f'
const GITHUB_VISIBILITY_CACHE_MS = 5 * 60 * 1_000
const GITHUB_API_TIMEOUT_MS = 8_000

export interface GitHubRepositoryReference {
  nameWithOwner: string
  url: string
}

export interface GitHubVisibilityResolver {
  resolve(reference: GitHubRepositoryReference): Promise<{
    visibility: GitHubRepositoryVisibility
    source: 'gh' | 'public-api'
  } | null>
}

export function parseGitHubRepositoryReference(
  rawUrl: string | null | undefined
): GitHubRepositoryReference | null {
  const value = rawUrl?.trim()
  if (!value) return null
  const scpMatch = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i)
  const normalized = scpMatch
    ? `https://github.com/${scpMatch[1]}/${scpMatch[2]}`
    : value
  try {
    const url = new URL(normalized)
    if (url.hostname.toLocaleLowerCase() !== 'github.com') return null
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, '')
      .split('/')
      .filter(Boolean)
    if (parts.length !== 2) return null
    const owner = parts[0]
    const name = parts[1].replace(/\.git$/i, '')
    if (
      !owner ||
      !name ||
      !/^[a-z0-9_.-]+$/i.test(owner) ||
      !/^[a-z0-9_.-]+$/i.test(name)
    ) {
      return null
    }
    return {
      nameWithOwner: `${owner}/${name}`,
      url: `https://github.com/${owner}/${name}`
    }
  } catch {
    return null
  }
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
    readonly stderr: string
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
        reject(new GitCommandError(message, detail))
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

export class GitService {
  private readonly visibilityCache = new Map<
    string,
    { expiresAt: number; status: GitHubRepositoryVisibilityStatus }
  >()

  constructor(
    private readonly store: Store,
    private readonly githubVisibility: GitHubVisibilityResolver =
      defaultGitHubVisibilityResolver
  ) {}

  async repositoryVisibility(
    projectId: string
  ): Promise<GitHubRepositoryVisibilityStatus> {
    const project = this.store.getProject(projectId)
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
    if (cached && cached.expiresAt > Date.now()) return cached.status
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
    this.visibilityCache.set(reference.nameWithOwner, {
      expiresAt: Date.now() + GITHUB_VISIBILITY_CACHE_MS,
      status
    })
    return status
  }

  async status(projectId: string): Promise<GitRepositoryStatus> {
    const { runner } = this.projectRunner(projectId)
    try {
      const [root, raw] = await Promise.all([
        runner.run(['rev-parse', '--show-toplevel']),
        runner.run([
          'status',
          '--porcelain=v2',
          '--branch',
          '--show-stash',
          '-z',
          '--untracked-files=all'
        ])
      ])
      const parsed = parseGitPorcelainV2(raw)
      return {
        isRepository: true,
        root: root.trim(),
        ...parsed,
        clean: parsed.changes.length === 0,
        message: null,
        refreshedAt: new Date().toISOString()
      }
    } catch (error) {
      if (isNotRepository(error)) {
        return unavailableStatus('This project folder is not a Git repository.')
      }
      throw error
    }
  }

  async commits(
    projectId: string,
    requestedOffset = 0,
    requestedLimit = DEFAULT_COMMIT_LIMIT
  ): Promise<GitCommitPage> {
    const offset = Number.isSafeInteger(requestedOffset)
      ? Math.max(0, requestedOffset)
      : 0
    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(MAX_COMMIT_LIMIT, Math.max(1, requestedLimit))
      : DEFAULT_COMMIT_LIMIT
    const { runner } = this.projectRunner(projectId)
    let total: number
    try {
      total = Number((await runner.run(['rev-list', '--all', '--count'])).trim()) || 0
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
      '--all',
      '--date-order',
      '--graph',
      '--decorate=short',
      `--max-count=${limit}`,
      `--skip=${offset}`,
      `--format=${LOG_RECORD}%H${LOG_FIELD}%h${LOG_FIELD}%P${LOG_FIELD}%D${LOG_FIELD}%an${LOG_FIELD}%aI${LOG_FIELD}%s`
    ])
    const commits = parseGitGraph(raw)
    return {
      commits,
      offset,
      total,
      hasMore: offset + commits.length < total
    }
  }

  private projectRunner(projectId: string): {
    project: Project
    connection: Connection
    runner: GitRunner
  } {
    const project = this.store.getProject(projectId)
    if (!project || project.archived) throw new Error('Project not found.')
    const connection = this.store.getConnection(project.connectionId)
    if (!connection) throw new Error('Project connection not found.')
    return { project, connection, runner: runnerFor(project, connection) }
  }
}
