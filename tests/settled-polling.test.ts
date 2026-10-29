import { afterEach, describe, expect, it, vi } from 'vitest'
import { InFlightReads, startSettledPolling } from '../src/renderer/src/lib/settledPolling'

class Visibility extends EventTarget {
  hidden = false
  change(hidden: boolean) {
    this.hidden = hidden
    this.dispatchEvent(new Event('visibilitychange'))
  }
}

function deferred<Value = void>() {
  let resolve!: (value: Value) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

afterEach(() => { vi.useRealTimers() })

describe('settlement and visibility based polling', () => {
  it('measures visible/hidden request counts without overlapping a slow request', async () => {
    vi.useFakeTimers()
    const visibility = new Visibility()
    const focus = new EventTarget()
    let running = 0
    let peak = 0
    const run = vi.fn(async () => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 25_000))
      running -= 1
    })
    const stop = startSettledPolling({ run, intervalMs: 12_000, visibility, focus })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(2)
    expect(peak).toBe(1)
    visibility.change(true)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(run).toHaveBeenCalledTimes(2)
    visibility.change(false)
    focus.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(3)
    expect(peak).toBe(1)
    stop()
    await vi.advanceTimersByTimeAsync(100_000)
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('does no work while initially hidden and retries failures after settlement', async () => {
    vi.useFakeTimers()
    const visibility = new Visibility()
    visibility.hidden = true
    const run = vi.fn().mockRejectedValue(new Error('temporary failure'))
    const stop = startSettledPolling({ run, intervalMs: 1_800, visibility })
    await vi.advanceTimersByTimeAsync(20_000)
    expect(run).not.toHaveBeenCalled()
    visibility.change(false)
    await vi.advanceTimersByTimeAsync(1_800)
    expect(run).toHaveBeenCalledTimes(2)
    stop()
    visibility.change(true)
    visibility.change(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('coalesces foreground/focus events during an in-flight read and cancels before first dispatch', async () => {
    vi.useFakeTimers()
    const visibility = new Visibility()
    const focus = new EventTarget()
    const pending = deferred()
    const run = vi.fn(() => pending.promise)
    const stop = startSettledPolling({ run, intervalMs: 1_800, visibility, focus })
    await vi.advanceTimersByTimeAsync(0)
    visibility.change(true)
    visibility.change(false)
    focus.dispatchEvent(new Event('focus'))
    expect(run).toHaveBeenCalledTimes(1)
    stop()
    pending.resolve()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(run).toHaveBeenCalledTimes(1)
    startSettledPolling({ run, intervalMs: 1_800, visibility })()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps required lifecycle work scheduled when visibility gating is omitted', async () => {
    vi.useFakeTimers()
    const run = vi.fn(async () => {})
    const stop = startSettledPolling({ run, intervalMs: 15_000 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(5)
    stop()
  })

  it('supports a one-shot snapshot that refreshes on foreground return', async () => {
    vi.useFakeTimers()
    const visibility = new Visibility()
    const run = vi.fn(async () => {})
    const stop = startSettledPolling({ run, intervalMs: null, visibility })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(run).toHaveBeenCalledTimes(1)
    visibility.change(true)
    visibility.change(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    stop()
  })
})

describe('in-flight read sharing', () => {
  it('shares identical running reads, isolates identities, and never caches settled values', async () => {
    const reads = new InFlightReads<string, string>()
    const first = deferred<string>()
    const read = vi.fn(() => first.promise)
    const initial = reads.run('project-a', read)
    expect(reads.run('project-a', read)).toBe(initial)
    await expect(reads.run('project-b', async () => 'b')).resolves.toBe('b')
    first.resolve('a')
    await expect(initial).resolves.toBe('a')
    await expect(reads.run('project-a', async () => 'fresh')).resolves.toBe('fresh')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('releases failed reads and can wait for existing work without starting a read', async () => {
    const reads = new InFlightReads<string, string>()
    const pending = deferred<string>()
    const initial = reads.run('project', () => pending.promise)
    const wait = reads.wait('project')
    pending.reject(new Error('offline'))
    await expect(initial).rejects.toThrow('offline')
    await wait
    await reads.wait('absent')
    await expect(reads.run('project', async () => 'reconnected')).resolves.toBe('reconnected')
  })
})
