import { describe, expect, it } from 'vitest'
import type { GitCommit } from '../src/shared/types'
import { buildGitTimeline, gitBranchAncestry, projectGitTimeline } from '../src/renderer/src/lib/gitTimeline'

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

  it('reuses ended branch lanes and keeps first-parent integration chains intact', () => {
    const graph = buildGitTimeline([
      commit('end', 'merge2'), commit('merge2', 'between', 'side2'), commit('side2', 'between'),
      commit('between', 'merge1'), commit('merge1', 'main', 'side1'), commit('side1', 'root'),
      commit('main', 'root'), commit('root')
    ], 'end', [{ name: 'main', hash: 'end', remote: false }, { name: 'first', hash: 'side1', remote: false }, { name: 'second', hash: 'side2', remote: false }])
    const nodes = new Map(graph.nodes.map((node) => [node.commit.hash, node]))
    expect(nodes.get('side1')!.lane).toBe(nodes.get('side2')!.lane)
    expect(graph.tracks.find((track) => track.name === 'first')).toBeDefined()
    expect(graph.edges.find((edge) => edge.parentHash === 'side1' && edge.childHash === 'merge1')!.path).toMatch(/H.+C/)
  })

  it('fits every active branch and its left-edge label into the visible vertical area', () => {
    const sides = Array.from({ length: 18 }, (_, index) => commit(`side${index}`, 'root'))
    const graph = buildGitTimeline([commit('merge', 'main', ...sides.map((node) => node.hash)), ...sides, commit('main', 'root'), commit('root')], 'merge',
      sides.map((node) => ({ name: `feature/${node.hash}`, hash: node.hash, remote: false })))
    const view = projectGitTimeline(graph, 150, 2200, 330)
    expect(view.labels.length).toBeGreaterThan(10)
    expect(new Set(view.labels.map((label) => label.y)).size).toBe(view.labels.length)
    expect(view.nodes.every((node) => node.y >= 60 && node.y <= 270)).toBe(true)
    expect(view.labels.every((label) => label.y >= 60 && label.y <= 270 && label.x >= 12)).toBe(true)
    expect(view.labels.filter((label) => label.start < 150).every((label) => label.x === 12)).toBe(true)
    expect(view.dense).toBe(true)
  })
})
