import { afterEach, expect, it, vi } from 'vitest'
import { getConversationHiddenCount, setConversationHiddenCount, subscribeConversationHiddenCount } from '../src/renderer/src/lib/conversationViewSession'

afterEach(() => setConversationHiddenCount(0))

it('shares a single count between mounted views and retains it without subscribers', () => {
  let first = 0
  let second = 0
  const removeFirst = subscribeConversationHiddenCount(() => { first = getConversationHiddenCount() })
  const removeSecond = subscribeConversationHiddenCount(() => { second = getConversationHiddenCount() })
  setConversationHiddenCount(3)
  expect([first, second]).toEqual([3, 3])
  removeFirst()
  removeSecond()
  expect(getConversationHiddenCount()).toBe(3)
  setConversationHiddenCount(7)
  expect(getConversationHiddenCount()).toBe(7)
  expect([first, second]).toEqual([3, 3])
})

it('normalizes a global number without clamping it to the selected chat length', () => {
  setConversationHiddenCount(50.9)
  expect(getConversationHiddenCount()).toBe(50)
  setConversationHiddenCount(-1)
  expect(getConversationHiddenCount()).toBe(0)
})

it('restores the same window-session count after a renderer reload', async () => {
  const values = new Map([['panepilot:chat-hidden-messages:session', '4']])
  vi.stubGlobal('window', { sessionStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value)
  } })
  try {
    vi.resetModules()
    const reloaded = await import('../src/renderer/src/lib/conversationViewSession')
    expect(reloaded.getConversationHiddenCount()).toBe(4)
    reloaded.setConversationHiddenCount(6)
    expect(values.get('panepilot:chat-hidden-messages:session')).toBe('6')
  } finally { vi.unstubAllGlobals() }
})
