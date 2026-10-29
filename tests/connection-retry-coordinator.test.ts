import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectionRetryCoordinator } from '../src/main/connection-retry-coordinator'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('connection retry coordinator', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('coalesces many sessions on one connection into one timer and stops after success', async () => {
    const coordinator = new ConnectionRetryCoordinator()
    const task = vi.fn(async () => true)
    for (let session = 0; session < 80; session += 1) coordinator.schedule('host', task)
    expect(coordinator.size).toBe(1)
    expect(coordinator.has('host')).toBe(true)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    expect(coordinator.size).toBe(0)
    expect(coordinator.has('host')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('backs off once per failed host and caps the delay without letting repeated schedules reset it', async () => {
    const coordinator = new ConnectionRetryCoordinator()
    const task = vi.fn(async () => false)
    coordinator.schedule('host', task)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    const delays = [1_000, 2_000, 5_000, 10_000, 30_000, 30_000]
    for (const [index, delay] of delays.entries()) {
      for (let session = 0; session < 50; session += 1) coordinator.schedule('host', task)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(task).toHaveBeenCalledTimes(index + 1)
      await vi.advanceTimersByTimeAsync(1)
      expect(task).toHaveBeenCalledTimes(index + 2)
    }
    coordinator.shutdown()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the latest task for a pending deadline and retries rejected tasks', async () => {
    const coordinator = new ConnectionRetryCoordinator()
    const old = vi.fn(async () => false)
    const replacement = vi.fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(true)
    coordinator.schedule('host', old)
    coordinator.schedule('host', replacement)
    await vi.advanceTimersByTimeAsync(0)
    expect(old).not.toHaveBeenCalled()
    expect(replacement).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(replacement).toHaveBeenCalledTimes(2)
    expect(coordinator.size).toBe(0)
  })

  it('never overlaps host checks and preserves a new request made during a successful check', async () => {
    const coordinator = new ConnectionRetryCoordinator()
    const first = deferred<boolean>()
    const task = vi.fn(() => first.promise)
    const next = vi.fn(async () => true)
    coordinator.schedule('host', task)
    await vi.advanceTimersByTimeAsync(0)
    for (let session = 0; session < 30; session += 1) coordinator.schedule('host', next)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(task).toHaveBeenCalledTimes(1)
    expect(next).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    first.resolve(true)
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(next).toHaveBeenCalledTimes(1)
    expect(coordinator.size).toBe(0)
  })

  it('resets backoff for an explicit retry, including one requested during an in-flight failure', async () => {
    const coordinator = new ConnectionRetryCoordinator()
    const pending = deferred<boolean>()
    const task = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(false)
    coordinator.schedule('host', task)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    coordinator.schedule('host', task, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(2)
    coordinator.schedule('host', task, true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(task).toHaveBeenCalledTimes(2)
    pending.resolve(false)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(999)
    expect(task).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(task).toHaveBeenCalledTimes(4)
    coordinator.shutdown()
  })

  it('keeps hosts independent and cancels only the chosen connection', async () => {
    const coordinator = new ConnectionRetryCoordinator()
    const one = vi.fn(async () => false)
    const two = vi.fn(async () => false)
    coordinator.schedule('one', one)
    coordinator.schedule('two', two)
    expect(vi.getTimerCount()).toBe(2)
    await vi.advanceTimersByTimeAsync(0)
    coordinator.cancel('one')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(one).toHaveBeenCalledTimes(1)
    expect(two).toHaveBeenCalledTimes(2)
    coordinator.shutdown()
  })

  it('ignores old in-flight completions after cancellation, replacement, and shutdown', async () => {
    const coordinator = new ConnectionRetryCoordinator()
    const old = deferred<boolean>()
    const current = deferred<boolean>()
    coordinator.schedule('host', () => old.promise)
    await vi.advanceTimersByTimeAsync(0)
    coordinator.cancel('host')
    const replacement = vi.fn(() => current.promise)
    coordinator.schedule('host', replacement)
    old.resolve(false)
    await Promise.resolve()
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(replacement).toHaveBeenCalledTimes(1)
    coordinator.shutdown()
    current.reject(new Error('closed'))
    await Promise.resolve()
    coordinator.schedule('ignored', async () => false)
    expect(coordinator.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects retry schedules that could create an endless zero-delay failure loop', () => {
    for (const delays of [[], [0], [0, 0], [-1, 100], [0, NaN], [0, 1.5]]) {
      expect(() => new ConnectionRetryCoordinator(delays)).toThrow(RangeError)
    }
  })
})
