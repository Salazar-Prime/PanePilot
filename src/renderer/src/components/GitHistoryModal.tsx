import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent
} from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, Copy, ExternalLink,
  GitBranch, Github, GitMerge, RefreshCw, X
} from 'lucide-react'
import type { GitBranchRef, GitCommit, GitRepositoryStatus } from '@shared/types'
import { parseGitHubRepositoryReference } from '@shared/git'
import { buildGitTimeline, projectGitTimeline } from '../lib/gitTimeline'
import { useModalEscape } from '../lib/modalEscape'
import { GitBranchBar } from './GitBranchBar'
import { gitBranchKey as branchKey } from '../lib/gitBranches'
import '../git-history.css'

interface Props {
  open: boolean
  projectId: string
  projectName: string
  repositoryUrl: string | null
  status: GitRepositoryStatus | null
  onRefreshStatus(): Promise<void>
  onClose(): void
}

const PAGE_SIZE = 80
const emptyMetrics = { left: 0, top: 0, width: 1000, height: 420 }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const dateLabel = (value: string) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : value
}

export function GitHistoryModal({
  open, projectId, projectName, repositoryUrl, status, onRefreshStatus, onClose
}: Props) {
  const reducedMotion = useReducedMotion()
  const [commits, setCommits] = useState<GitCommit[]>([])
  const [branches, setBranches] = useState<GitBranchRef[]>([])
  const [total, setTotal] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [branchError, setBranchError] = useState('')
  const [selectedHash, setSelectedHash] = useState<string | null>(null)
  const [branchFilter, setBranchFilter] = useState<string | null>(null)
  const [copyMessage, setCopyMessage] = useState('')
  const [copiedHash, setCopiedHash] = useState<string | null>(null)
  const [metrics, setMetrics] = useState(emptyMetrics)
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const overviewRef = useRef<HTMLDivElement>(null)
  const commitsRef = useRef(commits)
  const headRef = useRef(status?.head)
  const scopeTipRef = useRef<string>()
  const requestSequence = useRef(0)
  const branchSequence = useRef(0)
  const loadingRef = useRef(false)
  const initialPositioned = useRef(false)
  const positionedSize = useRef({ width: 0, height: 0 })
  const scrollFrame = useRef(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout>>()
  const copySequence = useRef(0)
  const anchorRef = useRef<{ hash: string; x: number } | null>(null)
  const dragRef = useRef<{ pointerId: number; x: number; left: number } | null>(null)
  const overviewDragging = useRef(false)
  headRef.current = status?.head

  const activeBranch = branches.find((branch) => branchKey(branch) === branchFilter)
  const model = useMemo(() => buildGitTimeline(commits, activeBranch?.hash ?? status?.head ?? null, branches), [commits, status?.head, branches, activeBranch?.hash])
  const modelRef = useRef(model)
  modelRef.current = model
  const paddingX = commits.length > 0 ? Math.max(0, metrics.width / 2 - 84) : 0
  const canvasWidth = commits.length > 0 ? model.width + paddingX * 2 : metrics.width
  const canvasHeight = metrics.height
  const paddingRef = useRef({ x: paddingX })
  paddingRef.current = { x: paddingX }
  const selected = commits.find((commit) => commit.hash === selectedHash) ?? commits[0] ?? null
  const github = parseGitHubRepositoryReference(status?.originUrl) ?? parseGitHubRepositoryReference(repositoryUrl)
  const slice = useMemo(() => projectGitTimeline(model, metrics.left - paddingX, metrics.width, metrics.height), [model, metrics.left, metrics.width, metrics.height, paddingX])
  const visibleNodes = slice.nodes
  const nodeMap = useMemo(() => new Map(model.nodes.map((node) => [node.commit.hash, node])), [model])
  const visibleEdges = slice.edges

  useModalEscape(onClose, open)

  const updateMetrics = useCallback(() => {
    const element = viewportRef.current
    if (!element) return
    const next = { left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight }
    setMetrics((current) => current.left === next.left && current.top === next.top && current.width === next.width && current.height === next.height ? current : next)
  }, [])

  const loadPage = useCallback(async (reset: boolean) => {
    if (loadingRef.current && !reset) return
    const request = ++requestSequence.current
    const offset = reset ? 0 : commitsRef.current.length
    loadingRef.current = true
    setLoading(true)
    setError('')
    if (reset) {
      commitsRef.current = []
      setCommits([])
      setTotal(0)
      setHasMore(false)
      initialPositioned.current = false
      anchorRef.current = null
    }
    try {
      const page = await window.projectConsole.git.commits(projectId, offset, PAGE_SIZE, scopeTipRef.current)
      if (request !== requestSequence.current) return
      if (!reset) {
        const viewport = viewportRef.current
        if (viewport) {
          const center = viewport.scrollLeft + viewport.clientWidth / 2 - paddingRef.current.x
          const anchor = modelRef.current.nodes.reduce<typeof model.nodes[number] | null>((best, node) =>
            !best || Math.abs(node.x - center) < Math.abs(best.x - center) ? node : best, null)
          if (anchor) anchorRef.current = {
            hash: anchor.commit.hash,
            x: anchor.x + paddingRef.current.x - viewport.scrollLeft
          }
        }
      }
      const existing = reset ? [] : commitsRef.current
      const known = new Set(existing.map((commit) => commit.hash))
      const next = [...existing, ...page.commits.filter((commit) => !known.has(commit.hash))]
      commitsRef.current = next
      setCommits(next)
      setTotal(page.total)
      setHasMore(page.hasMore && page.commits.length > 0)
      if (reset) {
        initialPositioned.current = false
        const tip = scopeTipRef.current ?? headRef.current
        setSelectedHash(next.some((commit) => commit.hash === tip) ? tip! : next[0]?.hash ?? null)
      }
    } catch (cause) {
      if (request === requestSequence.current) setError(errorMessage(cause))
    } finally {
      if (request === requestSequence.current) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }, [projectId])

  const loadBranches = useCallback(async () => {
    const request = ++branchSequence.current
    try {
      if (typeof window.projectConsole.git.branches !== 'function') {
        throw new Error('Restart PanePilot to enable branch discovery.')
      }
      const refs = await window.projectConsole.git.branches(projectId)
      if (request !== branchSequence.current) return
      setBranches(refs)
      setBranchError('')
    } catch (cause) {
      if (request === branchSequence.current) setBranchError(errorMessage(cause))
    }
  }, [projectId])

  useEffect(() => {
    if (!open) return
    commitsRef.current = []
    setCommits([])
    setBranches([])
    setSelectedHash(null)
    setBranchFilter(null)
    scopeTipRef.current = undefined
    setHasMore(false)
    setTotal(0)
    setCopyMessage('')
    setCopiedHash(null)
    copySequence.current += 1
    initialPositioned.current = false
    positionedSize.current = { width: 0, height: 0 }
    anchorRef.current = null
    loadingRef.current = false
    void loadPage(true)
    void loadBranches()
    return () => {
      requestSequence.current += 1
      branchSequence.current += 1
      loadingRef.current = false
      clearTimeout(copyTimer.current)
      copySequence.current += 1
      cancelAnimationFrame(scrollFrame.current)
    }
  }, [open, projectId, loadPage, loadBranches])

  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    const frame = requestAnimationFrame(() => closeRef.current?.focus())
    return () => {
      cancelAnimationFrame(frame)
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [open])

  useEffect(() => {
    if (!open || !viewportRef.current) return
    const viewport = viewportRef.current
    const observer = new ResizeObserver(updateMetrics)
    observer.observe(viewport)
    updateMetrics()
    const wheel = (event: WheelEvent) => {
      if (viewport.scrollHeight > viewport.clientHeight + 1 || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      event.preventDefault()
      viewport.scrollLeft += event.deltaY
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); viewport.removeEventListener('wheel', wheel) }
  }, [open, updateMetrics])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!open || !viewport || model.nodes.length === 0) return
    const anchor = anchorRef.current
    const node = nodeMap.get(anchor?.hash ?? selectedHash ?? '')
    if (anchor && node) {
      viewport.scrollLeft = node.x + paddingX - anchor.x
      anchorRef.current = null
    } else if (node && (!initialPositioned.current || positionedSize.current.width !== metrics.width || positionedSize.current.height !== metrics.height)) {
      viewport.scrollLeft = node.x + paddingX - viewport.clientWidth / 2
      initialPositioned.current = true
    }
    positionedSize.current = { width: metrics.width, height: metrics.height }
    viewport.scrollTop = 0
    updateMetrics()
  }, [open, model, nodeMap, selectedHash, paddingX, metrics.width, metrics.height, updateMetrics])

  function filterBranch(branch: GitBranchRef | null) {
    scopeTipRef.current = branch?.hash
    setBranchFilter(branch ? branchKey(branch) : null)
    setCopiedHash(null)
    setCopyMessage('')
    copySequence.current += 1
    void loadPage(true)
  }

  function selectCommit(commit: GitCommit) {
    setSelectedHash(commit.hash)
    copySequence.current += 1
    clearTimeout(copyTimer.current)
    setCopyMessage('')
    setCopiedHash(null)
  }

  async function copyCommit(commit: GitCommit) {
    const request = ++copySequence.current
    clearTimeout(copyTimer.current)
    try {
      await window.projectConsole.system.copyText(commit.hash)
      if (request !== copySequence.current) return
      setCopiedHash(commit.hash)
      setCopyMessage(`Copied ${commit.shortHash}`)
    } catch (cause) {
      if (request !== copySequence.current) return
      setCopiedHash(null)
      setCopyMessage(`Copy failed: ${errorMessage(cause)}`)
    }
    copyTimer.current = setTimeout(() => { setCopyMessage(''); setCopiedHash(null) }, 2200)
  }

  async function refresh() {
    await Promise.all([
      loadPage(true), loadBranches(),
      onRefreshStatus().catch((cause) => setError(errorMessage(cause)))
    ])
  }

  function scrollHistory(direction: -1 | 1) {
    const viewport = viewportRef.current
    if (!viewport) return
    viewport.scrollBy({ left: direction * viewport.clientWidth * 0.65, behavior: reducedMotion ? 'instant' : 'smooth' })
  }

  function moveOverview(clientX: number) {
    const rect = overviewRef.current?.getBoundingClientRect()
    const viewport = viewportRef.current
    if (!rect || !viewport) return
    viewport.scrollLeft = ((clientX - rect.left) / rect.width) * canvasWidth - viewport.clientWidth / 2
  }

  function trapFocus(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Tab') return
    const elements = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])]
      .filter((element) => element.getClientRects().length > 0)
    const first = elements[0], last = elements.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }

  function beginGraphDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, left: event.currentTarget.scrollLeft }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const overviewLeft = Math.min(100, Math.max(0, metrics.left / canvasWidth * 100))
  const overviewWidth = Math.min(100 - overviewLeft, metrics.width / canvasWidth * 100)
  const transition = { duration: reducedMotion ? 0 : 0.25, ease: 'easeOut' as const }

  return createPortal(<AnimatePresence>
    {open && <motion.div className="git-history-backdrop" key="git-history"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <motion.section className="git-history-modal" role="dialog" aria-modal="true"
        aria-label={`Git history for ${projectName}`} ref={dialogRef} onKeyDown={trapFocus}
        initial={{ opacity: 0, y: reducedMotion ? 0 : 16, scale: reducedMotion ? 1 : 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: reducedMotion ? 0 : 8 }} transition={transition}>
        <div className="gh-branch-row">
          <GitBranchBar key={projectId} branches={branches} selectedKey={branchFilter} currentBranch={status?.branch ?? null}
            colorFor={(branch, index) => nodeMap.get(branch.hash)?.color ?? ['#aab7f0', '#e2bc86', '#c6a3dc'][index % 3]}
            onSelect={filterBranch} />
          <span className="gh-count" title={branchError || `${total} commits in ${activeBranch?.name ?? 'all branches'}`}>
            {branches.length} branches <span>·</span> {commits.length}{total > commits.length ? ` / ${total}` : ''} commits
          </span>
          {github && <button className="gh-github-button" title={`Open ${github.nameWithOwner} on GitHub`}
            aria-label={`Open ${github.nameWithOwner} on GitHub`}
            onClick={() => { void window.projectConsole.projects.openRepository(github.url).catch((cause) => setError(errorMessage(cause))) }}>
            <Github size={15} /><span>GitHub</span><ExternalLink size={11} />
          </button>}
          <button className="icon-button" onClick={() => void refresh()} disabled={loading}
            title="Refresh Git history" aria-label="Refresh Git history"><RefreshCw size={14} className={loading ? 'spin' : ''} /></button>
          <button className="icon-button" onClick={onClose} ref={closeRef} aria-label="Close Git history" title="Close Git history"><X size={17} /></button>
        </div>

        <div className="gh-selection" aria-live="polite">
          <div className="gh-selected-copy">
            <span className="gh-selected-prefix">{projectName}<i />{selected ? (selected.parents.length > 1 ? 'Merge commit' : 'Commit') : 'Repository history'}</span>
            <h2 title={selected?.subject}>{selected?.subject ?? (loading ? 'Reading repository history…' : 'No commits yet')}</h2>
            {selected && <div className="gh-selected-meta"><span>{selected.author}</span><i /><time dateTime={selected.authoredAt}>{dateLabel(selected.authoredAt)}</time>
              {selected.decorations.length > 0 && <><i /><span title={selected.decorations.join(', ')}>{selected.decorations.join(' · ')}</span></>}
            </div>}
          </div>
          <div className="gh-selection-actions">
            {selected && selected.parents.length > 1 && <span className="gh-merge-label"><GitMerge size={12} />{selected.parents.length} parents merged</span>}
            {selected && <button className="gh-copy-hash" aria-label="Copy full commit SHA" title={`Copy full commit SHA: ${selected.hash}`} onClick={() => void copyCommit(selected)}>
              <code>{selected.shortHash}</code>{copiedHash === selected.hash ? <Check size={13} /> : <Copy size={13} />}
            </button>}
          </div>
        </div>

        {(error || branchError) && <div className="gh-error" role="status"><AlertTriangle size={13} /><span>{error || branchError}</span></div>}

        <section className="gh-canvas" aria-label="Horizontal Git commit graph">
          <div className="gh-canvas-heading"><strong>History window</strong><div>
            <span>Older</span><button aria-label="Scroll to older commits" onClick={() => scrollHistory(-1)}><ArrowLeft size={13} /></button>
            <button aria-label="Scroll to newer commits" onClick={() => scrollHistory(1)}><ArrowRight size={13} /></button><span>Newer</span>
          </div></div>
          <div className={`gh-viewport ${slice.dense ? 'dense' : ''}`} ref={viewportRef} tabIndex={0} aria-label="Scroll or drag through commit history"
            onScroll={() => {
              cancelAnimationFrame(scrollFrame.current)
              scrollFrame.current = requestAnimationFrame(updateMetrics)
              if (initialPositioned.current && viewportRef.current!.scrollLeft < 180 && hasMore && !error) void loadPage(false)
            }}
            onPointerDown={beginGraphDrag}
            onPointerMove={(event) => { if (dragRef.current?.pointerId === event.pointerId) event.currentTarget.scrollLeft = dragRef.current.left - (event.clientX - dragRef.current.x) }}
            onPointerUp={() => { dragRef.current = null }} onPointerCancel={() => { dragRef.current = null }}>
            <div className="gh-graph-content" style={{ width: canvasWidth, height: canvasHeight }}>
              <svg className="gh-edges" width={canvasWidth} height={canvasHeight} aria-hidden="true">
                <g transform={`translate(${paddingX} 0)`}>
                  {visibleEdges.map((edge) => <motion.path key={`${edge.parentHash}:${edge.childHash}`} d={edge.path} stroke={edge.color}
                    initial={false} animate={{ d: edge.path, opacity: 0.9 }} transition={transition} />)}
                </g>
              </svg>
              {visibleNodes.filter((node) => Math.round((node.x - 84) / 132) % 7 === 0).map((node) => <div className="gh-date-guide" key={`date:${node.commit.hash}`} style={{ left: node.x + paddingX }}>
                {dateLabel(node.commit.authoredAt)}
              </div>)}
              {visibleNodes.map((node) => <motion.button key={node.commit.hash}
                className={`gh-node ${node.commit.parents.length > 1 ? 'merge' : ''} ${selected?.hash === node.commit.hash ? 'selected' : ''}`}
                style={{ left: node.x + paddingX, '--gh-node-color': node.color } as CSSProperties}
                initial={false} animate={{ top: node.y, opacity: 1 }} transition={transition}
                aria-label={`${node.commit.shortHash}: ${node.commit.subject}. Select commit.`} aria-pressed={selected?.hash === node.commit.hash}
                title={`${node.commit.subject}\n${node.commit.author} · ${dateLabel(node.commit.authoredAt)}\n${node.commit.hash}`}
                onClick={() => selectCommit(node.commit)}>
                <span className="gh-node-dot" /><code>{node.commit.shortHash}</code>
              </motion.button>)}
              {commits.length === 0 && <div className="gh-empty">{loading ? <><RefreshCw size={22} className="spin" /><span>Reading commits…</span></> : <><GitBranch size={26} /><span>{error ? 'History is unavailable' : 'This repository has no commits yet.'}</span></>}</div>}
            </div>
          </div>
          <div className="gh-slice" aria-hidden="true"><span>Current slice</span></div>
          <div className="gh-rail-labels" aria-label="Branches in this history window">
            {slice.labels.map((track) => <motion.div key={`guide:${track.id}`} className="gh-rail-guide"
              initial={false} animate={{ y: track.y }} transition={transition} />)}
            {slice.labels.map((track) => <motion.div key={track.id} className="gh-rail-label"
              style={{ left: track.x, color: track.color }} initial={false}
              animate={{ y: track.y - 19 }} transition={transition}
              title={[track.name, ...track.aliases.filter((name) => name !== track.name)].join(' · ')}>
              {track.name}
            </motion.div>)}
          </div>
          <div className="gh-overview" ref={overviewRef} role="slider" tabIndex={0}
            aria-label="Visible history window" aria-valuemin={0} aria-valuemax={100}
            aria-valuenow={Math.round(overviewLeft)} aria-valuetext={`${commits.length} of ${total} commits loaded`}
            onPointerDown={(event) => { overviewDragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); moveOverview(event.clientX) }}
            onPointerMove={(event) => { if (overviewDragging.current) moveOverview(event.clientX) }}
            onPointerUp={() => { overviewDragging.current = false }} onPointerCancel={() => { overviewDragging.current = false }}
            onKeyDown={(event) => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); scrollHistory(event.key === 'ArrowLeft' ? -1 : 1) } }}>
            <svg viewBox={`0 0 ${canvasWidth} ${model.height}`} preserveAspectRatio="none" aria-hidden="true"><g transform={`translate(${paddingX} 0)`}>
              {model.edges.map((edge) => <path key={`${edge.parentHash}:${edge.childHash}`} d={edge.path} stroke={edge.color} />)}
            </g></svg>
            <div className="gh-overview-window" style={{ left: `${overviewLeft}%`, width: `${overviewWidth}%` }} />
          </div>
        </section>
        <footer className="gh-footer">
          <span role="status">{copyMessage || (activeBranch ? `History reachable from ${activeBranch.name}. Select a commit to inspect it.` : 'Select a commit to inspect it. Use the SHA button to copy. Scroll or drag to explore.')}</span>
          <div>{hasMore && <button onClick={() => void loadPage(false)} disabled={loading}>{loading ? 'Loading…' : 'Load older commits'}</button>}<span>Read only</span></div>
        </footer>
      </motion.section>
    </motion.div>}
  </AnimatePresence>, document.body)
}
