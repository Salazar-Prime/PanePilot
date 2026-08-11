import { describe, expect, it } from 'vitest'
import { isModalEscapeKey } from '../src/renderer/src/lib/modalEscape'

describe('modal Escape dismissal', () => {
  it('accepts one non-repeated Escape keypress', () => {
    expect(isModalEscapeKey({ key: 'Escape' })).toBe(true)
    expect(isModalEscapeKey({ key: 'Escape', repeat: true })).toBe(false)
    expect(isModalEscapeKey({ key: 'Escape', isComposing: true })).toBe(false)
    expect(isModalEscapeKey({ key: 'Enter' })).toBe(false)
  })
})
