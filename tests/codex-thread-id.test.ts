import { describe, expect, it } from 'vitest'
import { normalizeCodexThreadId } from '../src/main/codex-thread-id'

describe('Codex thread IDs', () => {
  it('normalizes an exact UUID supplied at terminal creation', () => {
    expect(
      normalizeCodexThreadId(
        ' 01975D42-5C29-7000-8B5C-95C32B24B84B '
      )
    ).toBe('01975d42-5c29-7000-8b5c-95c32b24b84b')
  })

  it('allows omission and rejects names or partial IDs', () => {
    expect(normalizeCodexThreadId()).toBeNull()
    expect(normalizeCodexThreadId('')).toBeNull()
    expect(() => normalizeCodexThreadId('my-old-codex-chat')).toThrow(
      'valid Codex thread ID'
    )
    expect(() => normalizeCodexThreadId('01975d42')).toThrow(
      'valid Codex thread ID'
    )
  })
})
