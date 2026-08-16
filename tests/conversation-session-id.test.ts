import { describe, expect, it, vi } from 'vitest'
import { copyConversationSessionId } from '../src/renderer/src/lib/conversationSessionId'

describe('LLM chat session ID copying', () => {
  it('copies the exact provider session ID without shortening it', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined)
    const sessionId = '01a00053-e734-7002-97fa-2c80738305ab'

    await expect(
      copyConversationSessionId(sessionId, copyText)
    ).resolves.toBe(true)
    expect(copyText).toHaveBeenCalledOnce()
    expect(copyText).toHaveBeenCalledWith(sessionId)
  })

  it('does not modify the clipboard when no provider ID is available', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined)

    await expect(copyConversationSessionId(null, copyText)).resolves.toBe(false)
    expect(copyText).not.toHaveBeenCalled()
  })
})
