import { afterEach, describe, expect, it, vi } from 'vitest'
import { PowerSavingService, type IdleChat } from '../src/main/power-saving-service'
import { DEFAULT_POWER_SAVING, validatePowerSaving } from '../src/shared/powerSaving'

afterEach(() => vi.useRealTimers())

function fixture(count = 5) {
  let now = 1_000_000
  const chats: IdleChat[] = Array.from({ length: count }, (_, i) => ({ id: String(i), idle: true, activityAt: now }))
  const deps = {
    readSettings: () => ({ enabled: true, idleMinutes: 1, keepAtLeast: 2 }),
    saveSettings: vi.fn(), snapshot: vi.fn(async () => [...chats]), notify: vi.fn(), now: () => now,
    suspend: vi.fn(async (id: string) => { chats.splice(chats.findIndex(chat => chat.id === id), 1); return true })
  }
  return { chats, deps, service: new PowerSavingService(deps), advance: (ms: number) => { now += ms } }
}

describe('power saving scheduling and floor', () => {
  it('waits a full idle interval and stops at the minimum live-chat count', async () => {
    const f = fixture()
    await f.service.check()
    expect(f.deps.suspend).not.toHaveBeenCalled()
    f.advance(59_999); await f.service.check()
    expect(f.deps.suspend).not.toHaveBeenCalled()
    f.advance(1); await f.service.check()
    expect(f.deps.suspend.mock.calls.map(call => call[0])).toEqual(['0', '1', '2'])
    expect(f.service.get()).toMatchObject({ liveChats: 2, suspended: 3, error: null })
    f.service.dispose()
  })

  it('protects active/visible/unknown chats and restarts the timer after interaction', async () => {
    const f = fixture()
    await f.service.check()
    f.advance(60_000)
    f.chats[0].idle = false
    f.chats[1].activityAt += 50_000
    await f.service.check()
    expect(f.deps.suspend.mock.calls.map(call => call[0])).toEqual(['2', '3', '4'])
    f.service.dispose()
  })

  it('has no timers or scans while disabled and validates persisted input', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.service.save({ ...DEFAULT_POWER_SAVING })
    f.service.start()
    await vi.advanceTimersByTimeAsync(600_000)
    await f.service.check()
    expect(f.deps.snapshot).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(() => f.service.save({ enabled: true, idleMinutes: 0, keepAtLeast: -1 })).toThrow()
    expect(f.service.get().settings).toEqual(DEFAULT_POWER_SAVING)
    f.service.dispose()
  })

  it('coalesces overlapping scans and does not stop anything after mode is disabled', async () => {
    const f = fixture()
    let resolve!: (chats: IdleChat[]) => void
    f.deps.snapshot.mockImplementation(() => new Promise(done => { resolve = done }))
    const first = f.service.check(), second = f.service.check()
    expect(first).toBe(second)
    f.service.save({ ...DEFAULT_POWER_SAVING })
    resolve(f.chats)
    await first
    expect(f.deps.suspend).not.toHaveBeenCalled()
    f.service.dispose()
  })

  it('stops an in-flight batch when settings change and bounds work per sweep', async () => {
    const f = fixture(12)
    await f.service.check(); f.advance(60_000)
    f.deps.suspend.mockImplementationOnce(async () => {
      f.service.save({ ...DEFAULT_POWER_SAVING })
      return true
    })
    await f.service.check()
    expect(f.deps.suspend).toHaveBeenCalledOnce()
    f.service.dispose()
    const bounded = fixture(12)
    await bounded.service.check(); bounded.advance(60_000); await bounded.service.check()
    expect(bounded.deps.suspend).toHaveBeenCalledTimes(4)
    bounded.service.dispose()
  })

  it('does not count a failed/rejected suspension and reports verification failures', async () => {
    const f = fixture()
    await f.service.check(); f.advance(60_000)
    f.deps.suspend.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('Tmux could not verify the target'))
    await f.service.check()
    expect(f.service.get()).toMatchObject({ suspended: 0, error: 'Tmux could not verify the target' })
    f.service.dispose()
  })

  it('lets later chats progress when the oldest chats are protected at the final check', async () => {
    const f = fixture(8)
    f.deps.suspend.mockImplementation(async id => Number(id) >= 4)
    await f.service.check(); f.advance(60_000); await f.service.check()
    expect(f.deps.suspend.mock.calls.map(call => call[0])).toEqual(['0', '1', '2', '3'])
    f.advance(30_000); await f.service.check()
    expect(f.deps.suspend.mock.calls.map(call => call[0])).toEqual(['0', '1', '2', '3', '4', '5', '6', '7'])
    expect(f.service.get().suspended).toBe(4)
    f.service.dispose()
  })

  it('rejects malformed or unbounded settings', () => {
    for (const value of [null, {}, { enabled: 1, idleMinutes: 30, keepAtLeast: 3 },
      { enabled: true, idleMinutes: NaN, keepAtLeast: 3 }, { enabled: true, idleMinutes: 30, keepAtLeast: 1001 }]) {
      expect(() => validatePowerSaving(value)).toThrow()
    }
    expect(validatePowerSaving({ enabled: true, idleMinutes: 1, keepAtLeast: 0 })).toEqual({ enabled: true, idleMinutes: 1, keepAtLeast: 0 })
  })
})
