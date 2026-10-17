import { describe, expect, it } from 'vitest'
import type { GitCommit } from '../src/shared/types'
import { buildGitTimeline, gitBranchAncestry } from '../src/renderer/src/lib/gitTimeline'

function commit(hash: string, ...parents: string[]): GitCommit {
  return { hash, shortHash: hash, parents, decorations: [], author: 'Test', authoredAt: '2026-10-17T12:00:00Z', subject: hash, graph: '*' }
}

describe('horizontal Git history', () => {
  const history = [commit('F', 'E'), commit('E', 'B', 'D'), commit('D', 'C'), commit('C', 'A'), commit('B', 'A'), commit('A')]

  it('keeps the current first-parent history together and reconnects a merged branch', () => {
    const graph = buildGitTimeline(history, 'F')
    const nodes = new Map(graph.nodes.map((node) => [node.commit.hash, node]))
    expect(['A', 'B', 'E', 'F'].map((hash) => nodes.get(hash)!.lane)).toEqual([0, 0, 0, 0])
    expect(nodes.get('C')!.lane).not.toBe(0)
    expect(nodes.get('C')!.lane).toBe(nodes.get('D')!.lane)
    expect(graph.edges.filter((edge) => edge.childHash === 'E')).toHaveLength(2)
    expect(graph.edges.find((edge) => edge.parentHash === 'D' && edge.childHash === 'E')).toMatchObject({ color: nodes.get('D')!.color, path: expect.stringContaining('C') })
    for (const edge of graph.edges) {
      expect(nodes.get(edge.parentHash)!.x).toBeLessThan(nodes.get(edge.childHash)!.x)
    }
  })

  it('represents every parent of an octopus merge without inventing missing history', () => {
    const graph = buildGitTimeline([
      commit('merge', 'main', 'left', 'right'), commit('right', 'root'),
      commit('left', 'root'), commit('main', 'root'), commit('root', 'outside-page')
    ], 'merge')
    expect(graph.edges.filter((edge) => edge.childHash === 'merge')).toHaveLength(3)
    expect(graph.edges.some((edge) => edge.parentHash === 'outside-page')).toBe(false)
    expect(new Set(graph.nodes.filter((node) => ['main', 'left', 'right'].includes(node.commit.hash)).map((node) => node.lane)).size).toBe(3)
    expect(graph.nodes.every((node) => Number.isFinite(node.x) && node.y > 0 && node.y < graph.height)).toBe(true)
  })

  it('focuses the real reachable ancestry, including both sides of a merge', () => {
    expect([...gitBranchAncestry('E', history)!].sort()).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect([...gitBranchAncestry('D', history)!].sort()).toEqual(['A', 'C', 'D'])
    expect(gitBranchAncestry('older-tip-not-loaded', history)).toBeNull()
  })
})
