import { describe, expect, it } from 'vitest'
import { fullCommitTime, shortCommitTime } from '../src/renderer/src/lib/gitCommitTime'

const now = Date.parse('2026-10-18T16:00:00Z')
const before = (seconds: number) => new Date(now - seconds * 1_000).toISOString()

describe('compact Git commit timestamps', () => {
  it.each([
    [0, 'now'], [59, 'now'], [60, '1m ago'], [3599, '59m ago'],
    [3600, '1h ago'], [86_399, '23h ago'], [86_400, '1d ago'],
    [604_800, '1w ago'], [2_592_000, '1mo ago'], [31_536_000, '1y ago']
  ])('formats %i elapsed seconds as %s', (seconds, expected) => {
    expect(shortCommitTime(before(seconds), now)).toBe(expected)
  })

  it('handles future dates and small clock skew without negative ages', () => {
    expect(shortCommitTime(before(-59), now)).toBe('now')
    expect(shortCommitTime(before(-120), now)).toBe('in 2m')
    expect(shortCommitTime(before(-7200), now)).toBe('in 2h')
  })

  it('updates relative labels from the supplied clock and honors timestamp offsets', () => {
    expect(shortCommitTime('2026-10-18T11:55:00-04:00', now)).toBe('5m ago')
    expect(shortCommitTime('2026-10-18T11:55:00-04:00', now + 60_000)).toBe('6m ago')
  })

  it('keeps full local date, time and timezone available without showing invalid dates', () => {
    const value = '2026-10-18T15:05:23Z'
    expect(fullCommitTime(value)).toBe(new Date(value).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short'
    }))
    expect(shortCommitTime('not a date', now)).toBe('—')
    expect(shortCommitTime(value, Number.NaN)).toBe('—')
    expect(fullCommitTime('not a date')).toBe('Unknown commit time')
  })
})
