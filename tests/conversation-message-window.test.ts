import { describe, expect, it } from 'vitest'
import { conversationMessageWindow } from '../src/renderer/src/lib/conversationMessageWindow'

describe('conversation rendering counter', () => {
  const messages = Object.freeze([
    { id: 'first', role: 'user' }, { id: 'second', role: 'assistant' },
    { id: 'third', role: 'user' }, { id: 'fourth', role: 'assistant' }
  ])

  it('hides exactly the first X boxes regardless of role without changing the archive', () => {
    const result = conversationMessageWindow(messages, 2)
    expect(result.hiddenCount).toBe(2)
    expect(result.messages.map((message) => message.id)).toEqual(['third', 'fourth'])
    expect(messages.map((message) => message.id)).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('restores all messages with zero and allows hiding all messages', () => {
    expect(conversationMessageWindow(messages, 0).messages).toEqual(messages)
    expect(conversationMessageWindow(messages, 4).messages).toEqual([])
  })

  it.each([[100, 4], [-5, 0], [2.8, 2], [NaN, 0], [Infinity, 0]])(
    'normalizes %s to a bounded whole-message count of %s', (input, expected) => {
      expect(conversationMessageWindow(messages, input).hiddenCount).toBe(expected)
    }
  )

  it('handles an empty conversation', () => {
    expect(conversationMessageWindow([], 3)).toEqual({ hiddenCount: 0, messages: [] })
  })
})
