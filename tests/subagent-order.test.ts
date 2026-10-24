import { describe, expect, it } from 'vitest'
import type { CodexSubagent } from '../src/shared/types'
import { orderSubagents } from '../src/renderer/src/lib/subagents'

const agent = (id: string, state: CodexSubagent['state'], path = `/root/${id}`): CodexSubagent => ({
  id, parentId: 'parent', name: id, path, state, updatedAt: '2026-10-24', output: [], truncated: false
})

describe('sub-agent display order', () => {
  it('puts working agents first, unknown next, and finished/stopped agents last', () => {
    const input = [agent('a', 'finished'), agent('z', 'working'), agent('b', 'stopped'), agent('y', 'unknown')]
    expect(orderSubagents(input).map((item) => item.id)).toEqual(['z', 'y', 'a', 'b'])
    expect(input.map((item) => item.id)).toEqual(['a', 'z', 'b', 'y'])
  })
  it('uses stable natural path/name order and exact identity for ties', () => {
    const input = [agent('10', 'working'), agent('2', 'working'), agent('b', 'unknown', ''), agent('a', 'unknown', '')]
    expect(orderSubagents(input).map((item) => item.id)).toEqual(['2', '10', 'a', 'b'])
    expect(orderSubagents([agent('b', 'working', '/same'), agent('a', 'working', '/same')]).map((item) => item.id)).toEqual(['a', 'b'])
  })
  it('only moves agents between groups when their status changes, not when output arrives', () => {
    const input = [agent('a', 'working'), agent('z', 'working')]
    expect(orderSubagents(input.map((item) => ({ ...item, updatedAt: item.id === 'a' ? 'old' : 'new' }))).map((item) => item.id)).toEqual(['a', 'z'])
    expect(orderSubagents([{ ...input[0], state: 'finished' }, input[1]]).map((item) => item.id)).toEqual(['z', 'a'])
    expect(orderSubagents([input[0], { ...input[1], state: 'finished' }]).map((item) => item.id)).toEqual(['a', 'z'])
  })
  it('prioritizes active agents before slicing pages', () => {
    const input = Array.from({ length: 12 }, (_, index) => agent(String(index), index >= 8 ? 'working' : 'finished'))
    expect(orderSubagents(input).slice(0, 4).every((item) => item.state === 'working')).toBe(true)
    expect(orderSubagents([])).toEqual([])
  })
})
