import type { GitCommit } from '@shared/types'

const NODE_GAP = 132
const LANE_GAP = 74
const LANE_COLORS = [
  '#80c9b7',
  '#aab7f0',
  '#e2bc86',
  '#c6a3dc',
  '#8db9d9',
  '#e3a6a3'
]

export interface GitTimelineNode {
  commit: GitCommit
  x: number
  y: number
  lane: number
  color: string
}

export interface GitTimelineEdge {
  parentHash: string
  childHash: string
  path: string
  color: string
}

export interface GitTimelineModel {
  nodes: GitTimelineNode[]
  edges: GitTimelineEdge[]
  width: number
  height: number
}

function laneColor(lane: number): string {
  if (lane === 0) return LANE_COLORS[0]
  const index = lane < 0 ? -lane * 2 - 1 : lane * 2
  return LANE_COLORS[1 + ((index - 1) % (LANE_COLORS.length - 1))]
}

function branchLane(index: number): number {
  return index % 2 === 1 ? -Math.ceil(index / 2) : index / 2
}

export function buildGitTimeline(
  newestFirst: GitCommit[],
  headHash: string | null
): GitTimelineModel {
  const ordered = [...newestFirst].reverse()
  const commitsByHash = new Map(ordered.map((commit) => [commit.hash, commit]))
  const mainline = new Set<string>()
  let cursor = headHash && commitsByHash.has(headHash)
    ? headHash
    : ordered.at(-1)?.hash
  while (cursor && !mainline.has(cursor)) {
    mainline.add(cursor)
    cursor = commitsByHash.get(cursor)?.parents[0]
  }

  const lanes = new Map<string, number>()
  const continuedParents = new Set<string>()
  let branchCount = 0
  for (const commit of ordered) {
    if (mainline.has(commit.hash)) {
      lanes.set(commit.hash, 0)
      continue
    }
    const parentHash = commit.parents[0]
    const parentLane = lanes.get(parentHash)
    if (parentLane != null && parentLane !== 0 && !continuedParents.has(parentHash)) {
      lanes.set(commit.hash, parentLane)
      continuedParents.add(parentHash)
    } else {
      branchCount += 1
      lanes.set(commit.hash, branchLane(branchCount))
    }
  }

  const values = [...lanes.values()]
  const upperLanes = Math.abs(Math.min(0, ...values))
  const lowerLanes = Math.max(0, ...values)
  const baseline = Math.max(200, 82 + upperLanes * LANE_GAP)
  const height = Math.max(360, baseline + lowerLanes * LANE_GAP + 94)
  const nodes = ordered.map((commit, index) => {
    const lane = lanes.get(commit.hash) ?? 0
    return {
      commit,
      x: 84 + index * NODE_GAP,
      y: baseline + lane * LANE_GAP,
      lane,
      color: laneColor(lane)
    }
  })
  const nodesByHash = new Map(nodes.map((node) => [node.commit.hash, node]))
  const edges: GitTimelineEdge[] = []
  for (const child of nodes) {
    for (const parentHash of child.commit.parents) {
      const parent = nodesByHash.get(parentHash)
      if (!parent) continue
      const difference = child.x - parent.x
      const bend = Math.min(72, Math.max(24, difference * 0.36))
      edges.push({
        parentHash,
        childHash: child.commit.hash,
        color: parent.color,
        path: parent.y === child.y
          ? `M${parent.x} ${parent.y}H${child.x}`
          : `M${parent.x} ${parent.y}C${parent.x + bend} ${parent.y} ${child.x - bend} ${child.y} ${child.x} ${child.y}`
      })
    }
  }
  return {
    nodes,
    edges,
    width: Math.max(1040, 168 + ordered.length * NODE_GAP),
    height
  }
}

export function gitBranchAncestry(
  tipHash: string,
  commits: GitCommit[]
): Set<string> | null {
  const byHash = new Map(commits.map((commit) => [commit.hash, commit]))
  if (!byHash.has(tipHash)) return null
  const reachable = new Set<string>()
  const pending = [tipHash]
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
