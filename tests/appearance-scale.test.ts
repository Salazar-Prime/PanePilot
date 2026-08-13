import { describe, expect, it } from 'vitest'
import {
  nextAppearanceScale,
  type AppearanceScale
} from '../src/renderer/src/lib/appearanceScale'

describe('appearance scale', () => {
  it('steps through bounded readable sizes', () => {
    expect(nextAppearanceScale(1, 1)).toBe(1.1)
    expect(nextAppearanceScale(1.1, -1)).toBe(1)
    expect(nextAppearanceScale(0.9, -1)).toBe(0.9)
    expect(nextAppearanceScale(1.25, 1)).toBe(1.25)
  })

  it('keeps the supported values narrow enough for the desktop layout', () => {
    const values: AppearanceScale[] = [0.9, 1, 1.1, 1.25]
    expect(values.every((value) => value >= 0.9 && value <= 1.25)).toBe(true)
  })
})
