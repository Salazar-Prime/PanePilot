import { describe, expect, it } from 'vitest'
import { conversationMessageWindow } from '../src/renderer/src/lib/conversationMessageWindow'
import { conversationDisplayWindow, normalizedHiddenMessageCount } from '../src/shared/conversation-messages'

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

  it('derives sidebar titles from retained messages and never mutates messages', () => {
    const messages = Object.freeze([
      { role: 'user' as const, content: 'Opening boilerplate' },
      { role: 'assistant' as const, content: 'Initial response' },
      { role: 'user' as const, content: 'Actual follow-up question' },
      { role: 'assistant' as const, content: 'Answer to follow-up' }
    ])
    const conversation = { title: 'Opening boilerplate', messages }
    expect(conversationDisplayWindow(conversation, 1).title).toBe('Initial response')
    expect(conversationDisplayWindow(conversation, 2).title).toBe('Actual follow-up question')
    expect(conversationDisplayWindow(conversation, 3).title).toBe('Answer to follow-up')
    expect(conversationDisplayWindow(conversation, 100).title).toBe('All messages hidden')
    expect(conversationDisplayWindow(conversation, 0).title).toBe('Opening boilerplate')
    expect(messages).toHaveLength(4)
  })

  it('keeps the shared request independent of a shorter selected conversation', () => {
    const requested = normalizedHiddenMessageCount(10)
    expect(conversationMessageWindow(messages, requested).hiddenCount).toBe(4)
    expect(requested).toBe(10)
    expect(normalizedHiddenMessageCount(2.9)).toBe(2)
    expect(normalizedHiddenMessageCount(NaN)).toBe(0)
    expect(normalizedHiddenMessageCount(Number.MAX_VALUE)).toBe(1_000_000)
  })
})
