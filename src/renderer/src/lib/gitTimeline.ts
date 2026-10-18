import type { GitBranchRef, GitCommit } from '@shared/types'

const NODE_GAP = 132
const LANE_GAP = 74
const COLORS = ['#80c9b7', '#aab7f0', '#e2bc86', '#c6a3dc', '#8db9d9', '#e3a6a3']

export interface GitTimelineNode {
  commit: GitCommit
  x: number
  y: number
  lane: number
  trackId: number
  color: string
}

export interface GitTimelineEdge {
  parentHash: string
  childHash: string
  parentIndex: number
  trackId: number
  fromX: number
  toX: number
  path: string
  color: string
}

export interface GitTimelineTrack {
  id: number
  name: string
  aliases: string[]
  start: number
  end: number
  lane: number
  color: string
}

export interface GitTimelineModel {
  nodes: GitTimelineNode[]
  edges: GitTimelineEdge[]
  tracks: GitTimelineTrack[]
  width: number
  height: number
}

function branchLane(index: number): number {
  return index % 2 === 1 ? -Math.ceil(index / 2) : index / 2
}

function edgePath(parent: GitTimelineNode, child: GitTimelineNode, parentIndex: number): string {
  if (parent.trackId === child.trackId) return `M${parent.x} ${parent.y}H${child.x}`
  const bend = Math.min(46, Math.max(0, (child.x - parent.x) / 2))
  // Keep long edges horizontal; bend only at the fork or merge.
  return parentIndex === 0
    ? `M${parent.x} ${parent.y}C${parent.x + bend} ${parent.y} ${parent.x + bend} ${child.y} ${parent.x + bend * 2} ${child.y}H${child.x}`
    : `M${parent.x} ${parent.y}H${child.x - bend * 2}C${child.x - bend} ${parent.y} ${child.x - bend} ${child.y} ${child.x} ${child.y}`
}

function decorationName(commit: GitCommit): string | undefined {
  return commit.decorations.map((name) => name.replace(/^HEAD -> /, ''))
    .find((name) => name !== 'HEAD' && !name.startsWith('tag: ') && name !== 'refs/stash')
}

export function buildGitTimeline(newestFirst: GitCommit[], headHash: string | null, branches: GitBranchRef[] = []): GitTimelineModel {
  const ordered = [...newestFirst].reverse()
  const byHash = new Map(ordered.map((commit, index) => [commit.hash, { commit, index }]))
  const names = new Map<string, string[]>()
  for (const branch of [...branches].sort((a, b) => Number(a.remote) - Number(b.remote))) {
    names.set(branch.hash, [...(names.get(branch.hash) ?? []), branch.name])
  }
  const owners = new Map<string, number>()
  const tracks: GitTimelineTrack[] = []
  const primary = headHash && byHash.has(headHash) ? headHash : newestFirst[0]?.hash
  function claim(tip: string) {
    const existing = owners.get(tip)
    if (existing != null) {
      tracks[existing].aliases = [...new Set([...tracks[existing].aliases, ...(names.get(tip) ?? [])])]
      return
    }
    const seed = byHash.get(tip)
    if (!seed) return
    const id = tracks.length
    const aliases = names.get(tip) ?? []
    const track: GitTimelineTrack = {
      id, name: aliases[0] ?? decorationName(seed.commit) ?? (tip === primary ? 'HEAD' : `Merged branch · ${seed.commit.shortHash}`),
      aliases, start: Infinity, end: -Infinity, lane: 0, color: COLORS[id % COLORS.length]
    }
    tracks.push(track)
    let cursor: string | undefined = tip
    while (cursor && byHash.has(cursor) && !owners.has(cursor)) {
      const entry: { commit: GitCommit; index: number } = byHash.get(cursor)!
      owners.set(cursor, id)
      const x = 84 + entry.index * NODE_GAP
      track.start = Math.min(track.start, x)
      track.end = Math.max(track.end, x)
      cursor = entry.commit.parents[0]
    }
  }
  if (primary) claim(primary)
  // Claim integration histories before their merged side branches.
  const tips = [...names.keys()].filter((hash) => byHash.has(hash))
    .sort((a, b) => byHash.get(b)!.index - byHash.get(a)!.index)
  tips.forEach(claim)
  newestFirst.forEach((commit) => claim(commit.hash))
  for (const child of ordered) {
    child.parents.forEach((hash, parentIndex) => {
      const parent = byHash.get(hash)
      if (!parent) return
      const rail = tracks[owners.get(parentIndex === 0 ? child.hash : hash)!]
      rail.start = Math.min(rail.start, 84 + parent.index * NODE_GAP)
      rail.end = Math.max(rail.end, 84 + byHash.get(child.hash)!.index * NODE_GAP)
    })
  }
  // Ended branches release their lanes. Lane zero belongs to HEAD's chain.
  const laneEnds: number[] = []
  for (const track of tracks.slice(1).sort((a, b) => a.start - b.start || b.end - a.end)) {
    let slot = laneEnds.findIndex((end) => end < track.start)
    if (slot < 0) slot = laneEnds.length
    laneEnds[slot] = track.end
    track.lane = branchLane(slot + 1)
  }
  const upper = Math.abs(Math.min(0, ...tracks.map((track) => track.lane)))
  const lower = Math.max(0, ...tracks.map((track) => track.lane))
  const baseline = Math.max(200, 82 + upper * LANE_GAP)
  const height = Math.max(360, baseline + lower * LANE_GAP + 94)
  const nodes = ordered.map((commit, index) => {
    const track = tracks[owners.get(commit.hash)!]
    return { commit, x: 84 + index * NODE_GAP, y: baseline + track.lane * LANE_GAP, lane: track.lane, trackId: track.id, color: track.color }
  })
  const nodeMap = new Map(nodes.map((node) => [node.commit.hash, node]))
  const edges: GitTimelineEdge[] = []
  for (const child of nodes) {
    child.commit.parents.forEach((hash, parentIndex) => {
      const parent = nodeMap.get(hash)
      if (!parent) return
      const rail = tracks[parentIndex === 0 ? child.trackId : parent.trackId]
      edges.push({ parentHash: hash, childHash: child.commit.hash, parentIndex, trackId: rail.id,
        fromX: parent.x, toX: child.x, color: rail.color, path: edgePath(parent, child, parentIndex) })
    })
  }
  return { nodes, edges, tracks, width: Math.max(1040, 168 + ordered.length * NODE_GAP), height }
}

export function projectGitTimeline(model: GitTimelineModel, left: number, width: number, height: number) {
  const right = left + width
  const active = model.tracks.filter((track) => track.end >= left - 24 && track.start <= right + 24)
    .sort((a, b) => a.lane - b.lane || a.start - b.start)
  const gap = Math.min(104, Math.max(0, (height - 136) / Math.max(1, active.length - 1)))
  const top = (height - gap * (active.length - 1)) / 2
  const positions = new Map(active.map((track, index) => [track.id, top + index * gap]))
  const allNodes = new Map(model.nodes.map((node) => [node.commit.hash, node]))
  const nodes = model.nodes.filter((node) => node.x >= left - 24 && node.x <= right + 24 && positions.has(node.trackId))
    .map((node) => ({ ...node, y: positions.get(node.trackId)! }))
  const edges = model.edges.filter((edge) => edge.toX >= left - 24 && edge.fromX <= right + 24).map((edge) => {
    const parent = allNodes.get(edge.parentHash)!, child = allNodes.get(edge.childHash)!
    const railY = positions.get(edge.trackId) ?? height / 2
    return { ...edge, path: edgePath({ ...parent, y: positions.get(parent.trackId) ?? railY }, { ...child, y: positions.get(child.trackId) ?? railY }, edge.parentIndex) }
  })
  const labels = active.map((track) => ({ ...track, x: 12, y: positions.get(track.id)! }))
  return { nodes, edges, labels, dense: gap < 40 }
}

export function gitBranchAncestry(tipHash: string, commits: GitCommit[]): Set<string> | null {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]))
  if (!byHash.has(tipHash)) return null
  const reachable = new Set<string>(), pending = [tipHash]
  while (pending.length > 0) {
    const hash = pending.pop()!
    if (reachable.has(hash)) continue
    const commit = byHash.get(hash)
    if (!commit) continue
    reachable.add(hash)
    pending.push(...commit.parents)
  }
  return reachable
}
