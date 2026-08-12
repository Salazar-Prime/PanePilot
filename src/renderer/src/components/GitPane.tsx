import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type UIEvent
} from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  GitBranch,
  GitCommit as GitCommitIcon,
  Layers3,
  RefreshCw,
  X
} from 'lucide-react'
import type {
  GitChangeKind,
  GitCommit,
  GitFileChange,
  GitRepositoryStatus
} from '@shared/types'
import { shouldLoadOlderGitCommits } from '../lib/gitPane'

const COMMIT_PAGE_SIZE = 80

interface GitPaneProps {
  projectId: string
  projectName: string
  status: GitRepositoryStatus | null
  statusLoading: boolean
  statusError: string
  onRefreshStatus(): Promise<void>
  onClose(): void
}

interface ChangeGroupProps {
  title: string
  tone: 'conflict' | 'staged' | 'working' | 'untracked'
  entries: GitFileChange[]
  kindFor(entry: GitFileChange): GitChangeKind | null
}

function statusCode(kind: GitChangeKind | null, untracked = false): string {
  if (untracked) return '?'
  switch (kind) {
    case 'added':
      return 'A'
    case 'copied':
      return 'C'
    case 'deleted':
      return 'D'
    case 'modified':
      return 'M'
    case 'renamed':
      return 'R'
    case 'type-changed':
      return 'T'
    case 'unmerged':
      return 'U'
    default:
      return '·'
  }
}

function statusName(kind: GitChangeKind | null, untracked = false): string {
  if (untracked) return 'Untracked'
  return kind ? kind.replace('-', ' ') : 'Changed'
}

function ChangeGroup({ title, tone, entries, kindFor }: ChangeGroupProps) {
  if (entries.length === 0) return null
  return (
    <details className={`git-change-group ${tone}`} open>
      <summary>
        <span>{title}</span>
        <small>{entries.length}</small>
      </summary>
      <div className="git-change-list">
        {entries.map((entry) => {
          const kind = kindFor(entry)
          return (
            <div
              className="git-change-row"
              key={`${tone}:${entry.path}`}
              title={`${statusName(kind, entry.untracked)}: ${entry.path}`}
            >
              <span className="git-change-code" aria-hidden="true">
                {statusCode(kind, entry.untracked)}
              </span>
              <span className="git-change-path">
                <span>{entry.path}</span>
                {entry.previousPath && <small>from {entry.previousPath}</small>}
              </span>
            </div>
          )
        })}
      </div>
    </details>
  )
}

function GraphRail({ value }: { value: string }) {
  return (
    <span className="git-graph-rail" aria-hidden="true">
      {[...value].map((character, index) => (
        <span
          className={`lane-${index % 5} ${
            character === '*' || character === '|' ? 'rail-segment' : ''
          } ${character === '*' ? 'rail-node' : ''}`}
          key={`${index}:${character}`}
        >
          {character === ' ' ? '\u00a0' : character}
        </span>
      ))}
    </span>
  )
}

function decorationLabel(value: string): { label: string; kind: string } {
  if (value.startsWith('HEAD -> ')) {
    return { label: value.slice('HEAD -> '.length), kind: 'head' }
  }
  if (value.startsWith('tag: ')) {
    return { label: value.slice('tag: '.length), kind: 'tag' }
  }
  if (value === 'HEAD') return { label: value, kind: 'head' }
  if (value.includes('/')) return { label: value, kind: 'remote' }
  return { label: value, kind: 'branch' }
}

function relativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const seconds = Math.round((timestamp - Date.now()) / 1_000)
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60]
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, divisor] of ranges) {
    if (Math.abs(seconds) >= divisor) {
      return formatter.format(Math.round(seconds / divisor), unit)
    }
  }
  return 'just now'
}

function CommitRow({ commit }: { commit: GitCommit }) {
  return (
    <article className="git-commit-row">
      <GraphRail value={commit.graph} />
      <div className="git-commit-copy">
        {commit.decorations.length > 0 && (
          <div className="git-ref-list">
            {commit.decorations.map((decoration) => {
              const parsed = decorationLabel(decoration)
              return (
                <span className={`git-ref ${parsed.kind}`} key={decoration}>
                  {parsed.label}
                </span>
              )
            })}
          </div>
        )}
        <strong title={commit.subject}>{commit.subject}</strong>
        <div className="git-commit-meta">
          <code title={commit.hash}>{commit.shortHash}</code>
          <span>{commit.author}</span>
          <time dateTime={commit.authoredAt} title={new Date(commit.authoredAt).toLocaleString()}>
            {relativeTime(commit.authoredAt)}
          </time>
        </div>
      </div>
    </article>
  )
}

function repositoryLabel(root: string | null): string {
  if (!root) return 'Repository'
  return root.split(/[\\/]/).filter(Boolean).at(-1) ?? root
}

export function GitPane({
  projectId,
  projectName,
  status,
  statusLoading,
  statusError,
  onRefreshStatus,
  onClose
}: GitPaneProps) {
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [commitTotal, setCommitTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [commitLoading, setCommitLoading] = useState(false)
  const [commitError, setCommitError] = useState('')
  const requestSequence = useRef(0)
  const commitLoadingRef = useRef(false)

  const loadCommits = useCallback(
    async (reset: boolean) => {
      if (!reset && commitLoadingRef.current) return
      const request = ++requestSequence.current
      const offset = reset ? 0 : commits.length
      commitLoadingRef.current = true
      setCommitLoading(true)
      if (reset) setCommitError('')
      try {
        const page = await window.projectConsole.git.commits(
          projectId,
          offset,
          COMMIT_PAGE_SIZE
        )
        if (request !== requestSequence.current) return
        setCommits((current) => (reset ? page.commits : [...current, ...page.commits]))
        setCommitTotal(page.total)
        setHasMore(page.hasMore)
      } catch (error) {
        if (request !== requestSequence.current) return
        setCommitError(error instanceof Error ? error.message : String(error))
      } finally {
        if (request === requestSequence.current) {
          commitLoadingRef.current = false
          setCommitLoading(false)
        }
      }
    },
    [commits.length, projectId]
  )

  useEffect(() => {
    requestSequence.current += 1
    setCommits([])
    setCommitTotal(0)
    setHasMore(false)
    setCommitError('')
    if (status?.isRepository) void loadCommits(true)
  }, [projectId, status?.isRepository])

  const groups = useMemo(() => {
    const changes = status?.changes ?? []
    return {
      conflicts: changes.filter((entry) => entry.conflicted),
      staged: changes.filter((entry) => !entry.conflicted && entry.staged),
      working: changes.filter(
        (entry) => !entry.conflicted && !entry.untracked && entry.workingTree
      ),
      untracked: changes.filter((entry) => entry.untracked)
    }
  }, [status?.changes])

  async function refreshAll() {
    await Promise.all([onRefreshStatus(), loadCommits(true)])
  }

  function handlePaneScroll(event: UIEvent<HTMLDivElement>) {
    if (!hasMore || commitLoadingRef.current) return
    const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
    if (shouldLoadOlderGitCommits(scrollTop, clientHeight, scrollHeight)) {
      void loadCommits(false)
    }
  }

  return (
    <aside className="git-pane" aria-label={`Git activity for ${projectName}`}>
      <header className="git-pane-header">
        <div className="git-pane-heading">
          <span className="git-pane-mark">
            <GitBranch size={15} />
          </span>
          <span>
            <strong>Git</strong>
            <small>{repositoryLabel(status?.root ?? null)}</small>
          </span>
        </div>
        <div className="git-pane-actions">
          <button
            className="icon-button"
            onClick={() => void refreshAll()}
            disabled={statusLoading || commitLoading}
            aria-label="Refresh Git status and commits"
            title="Refresh Git status and commits"
          >
            <RefreshCw size={14} className={statusLoading || commitLoading ? 'spin' : ''} />
          </button>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close Git pane"
            title="Close Git pane"
          >
            <X size={15} />
          </button>
        </div>
      </header>

      {statusError ? (
        <div className="git-pane-empty error">
          <AlertTriangle size={22} />
          <strong>Git status is unavailable</strong>
          <p>{statusError}</p>
          <button className="secondary-button" onClick={() => void onRefreshStatus()}>
            Try again
          </button>
        </div>
      ) : !status && statusLoading ? (
        <div className="git-pane-loading">
          <RefreshCw size={16} className="spin" /> Reading repository…
        </div>
      ) : status && !status.isRepository ? (
        <div className="git-pane-empty">
          <GitBranch size={24} />
          <strong>No Git repository here</strong>
          <p>{status.message}</p>
        </div>
      ) : status ? (
        <div className="git-pane-scroll" onScroll={handlePaneScroll}>
          <section className="git-branch-card">
            <div className="git-current-branch">
              <GitBranch size={14} />
              <strong>{status.branch ?? `Detached at ${status.head?.slice(0, 8) ?? 'HEAD'}`}</strong>
              {status.head && <code>{status.head.slice(0, 8)}</code>}
            </div>
            <div className="git-sync-row">
              {status.upstream ? <span>{status.upstream}</span> : <span>No upstream</span>}
              <div>
                {status.ahead > 0 && (
                  <small title={`${status.ahead} commit${status.ahead === 1 ? '' : 's'} ahead`}>
                    <ArrowUp size={11} /> {status.ahead}
                  </small>
                )}
                {status.behind > 0 && (
                  <small title={`${status.behind} commit${status.behind === 1 ? '' : 's'} behind`}>
                    <ArrowDown size={11} /> {status.behind}
                  </small>
                )}
                {status.stashCount > 0 && (
                  <small title={`${status.stashCount} stash${status.stashCount === 1 ? '' : 'es'}`}>
                    <Layers3 size={11} /> {status.stashCount}
                  </small>
                )}
              </div>
            </div>
          </section>

          <section className="git-working-tree">
            <div className="git-section-heading">
              <span>
                <strong>Working tree</strong>
                <small>{status.clean ? 'Clean' : `${status.changes.length} changed`}</small>
              </span>
              {status.clean && <CheckCircle2 size={15} />}
            </div>
            {status.clean ? (
              <div className="git-clean-state">
                <span className="git-clean-line" />
                No local changes
              </div>
            ) : (
              <div className="git-change-groups">
                <ChangeGroup
                  title="Conflicts"
                  tone="conflict"
                  entries={groups.conflicts}
                  kindFor={() => 'unmerged'}
                />
                <ChangeGroup
                  title="Staged for commit"
                  tone="staged"
                  entries={groups.staged}
                  kindFor={(entry) => entry.staged}
                />
                <ChangeGroup
                  title="Working changes"
                  tone="working"
                  entries={groups.working}
                  kindFor={(entry) => entry.workingTree}
                />
                <ChangeGroup
                  title="Untracked"
                  tone="untracked"
                  entries={groups.untracked}
                  kindFor={() => null}
                />
              </div>
            )}
          </section>

          <section className="git-history">
            <div className="git-section-heading git-history-heading">
              <span>
                <strong>Commit graph</strong>
                <small>
                  {commitTotal === 0
                    ? 'No commits'
                    : `${commits.length} of ${commitTotal}`}
                </small>
              </span>
              <GitCommitIcon size={15} />
            </div>
            <div className="git-commit-list">
              {commits.map((commit) => (
                <CommitRow commit={commit} key={commit.hash} />
              ))}
              {commitError && (
                <div className="git-history-message error">
                  <AlertTriangle size={14} /> {commitError}
                </div>
              )}
              {!commitLoading && commits.length === 0 && !commitError && (
                <div className="git-history-message">The repository has no commits yet.</div>
              )}
              {commitLoading && (
                <div className="git-history-message">
                  <RefreshCw size={13} className="spin" /> Loading commits…
                </div>
              )}
              {hasMore && !commitLoading && (
                <button className="git-load-more" onClick={() => void loadCommits(false)}>
                  Load older commits
                  <small>{commitTotal - commits.length} remaining</small>
                </button>
              )}
            </div>
          </section>
        </div>
      ) : null}
    </aside>
  )
}
