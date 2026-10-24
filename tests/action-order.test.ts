import { describe, expect, it } from 'vitest'
import {
  ACTION_ORDER_PREFIX, loadActionOrder, moveAction, orderProjectActions,
  saveActionOrder, validActionOrder
} from '../src/renderer/src/lib/actionOrder'

describe('client-local action order', () => {
  const actions = ['a', 'b', 'c'].map((id) => ({ id, command: `run-${id}` }))

  it('keeps the source order until the user arranges actions', () => {
    expect(orderProjectActions(actions, [])).toEqual(actions)
  })

  it('restores saved order, drops stale IDs and appends newly shared actions', () => {
    const result = orderProjectActions(actions, ['c', 'deleted', 'a', 'c'])
    expect(result.map((action) => action.id)).toEqual(['c', 'a', 'b'])
    expect(result[0]).toBe(actions[2])
    expect(actions.map((action) => action.id)).toEqual(['a', 'b', 'c'])
  })

  it('moves in either direction without changing definitions or the original IDs', () => {
    const ids = ['a', 'b', 'c']
    expect(moveAction(ids, 'a', 2)).toEqual(['b', 'c', 'a'])
    expect(moveAction(ids, 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveAction(ids, 'b', 1)).toBe(ids)
    expect(moveAction(ids, 'missing', 0)).toBe(ids)
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('clamps indices and rejects invalid numbers', () => {
    const ids = ['a', 'b', 'c']
    expect(moveAction(ids, 'c', -10)).toEqual(['c', 'a', 'b'])
    expect(moveAction(ids, 'a', 100)).toEqual(['b', 'c', 'a'])
    expect(moveAction(ids, 'c', 0.9)).toEqual(['c', 'a', 'b'])
    expect(moveAction(ids, 'a', NaN)).toBe(ids)
    expect(moveAction(ids, 'a', Infinity)).toBe(ids)
  })

  it('validates and deduplicates preference data', () => {
    expect(validActionOrder(['b', null, 'a', 'b', '', 42])).toEqual(['b', 'a'])
    expect(validActionOrder({ a: 1 })).toEqual([])
  })

  it('remembers projects independently without rewriting shared definitions', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }
    }
    saveActionOrder('local', ['c', 'a', 'b'], storage)
    saveActionOrder('ssh', ['b', 'a'], storage)
    expect(loadActionOrder('local', storage)).toEqual(['c', 'a', 'b'])
    expect(loadActionOrder('ssh', storage)).toEqual(['b', 'a'])
    expect(loadActionOrder('new-project', storage)).toEqual([])
    values.set(ACTION_ORDER_PREFIX + 'local', 'broken-json')
    expect(loadActionOrder('local', storage)).toEqual([])
    values.set(ACTION_ORDER_PREFIX + 'local', '{"a":1}')
    expect(loadActionOrder('local', storage)).toEqual([])
  })

  it('does not break actions when browser preference storage is unavailable', () => {
    const blocked = {
      getItem: () => { throw new Error('Storage unavailable') },
      setItem: () => { throw new Error('Quota exceeded') }
    }
    expect(loadActionOrder('project', blocked)).toEqual([])
    expect(() => saveActionOrder('project', ['a'], blocked)).not.toThrow()
  })
})
