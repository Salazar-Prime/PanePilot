import { describe, expect, it } from 'vitest'
import {
  acknowledgedAgentState,
  ScreenActivityDetector
} from '../src/main/screen-activity-detector'

describe('ScreenActivityDetector', () => {
  it('does not infer agent work before the visible marker appears', () => {
    const detector = new ScreenActivityDetector()

    expect(detector.inspect('Welcome to Codex')).toBeNull()
    expect(detector.inspect('$ ls')).toBeNull()
  })

  it('marks an agent as running while esc to interrupt is visible', () => {
    const detector = new ScreenActivityDetector()

    expect(detector.inspect('Working…  esc to interrupt')).toBe('running')
    expect(detector.inspect('ESC   TO   INTERRUPT')).toBe('running')
  })

  it('requests attention once the marker disappears', () => {
    const detector = new ScreenActivityDetector()

    expect(detector.inspect('esc to interrupt')).toBe('running')
    expect(detector.inspect('Done.')).toBe('needs-attention')
    expect(detector.inspect('Done.')).toBeNull()
  })

  it('re-arms for a later turn', () => {
    const detector = new ScreenActivityDetector()

    detector.inspect('esc to interrupt')
    detector.inspect('First response')

    expect(detector.inspect('esc to interrupt')).toBe('running')
    expect(detector.inspect('Second response')).toBe('needs-attention')
  })
})

describe('acknowledgedAgentState', () => {
  it('returns a completed fallback turn to idle when its terminal is opened', () => {
    expect(acknowledgedAgentState('needs-attention')).toBe('idle')
    expect(acknowledgedAgentState('response-ready')).toBe('idle')
  })

  it('does not clear active or sticky states', () => {
    expect(acknowledgedAgentState('running')).toBe('running')
    expect(acknowledgedAgentState('needs-input')).toBe('needs-input')
  })
})
