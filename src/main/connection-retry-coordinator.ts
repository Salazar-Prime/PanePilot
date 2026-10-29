const DEFAULT_RETRY_DELAYS_MS = [0, 1_000, 2_000, 5_000, 10_000, 30_000]

type RetryTask = () => Promise<boolean>

interface ConnectionRetry {
  task: RetryTask
  attempt: number
  timer: NodeJS.Timeout | null
  running: boolean
  requestedWhileRunning: boolean
  immediateAfterRun: boolean
}

/**
 * One retry clock per connection, independent of its number of terminal tabs.
 * A task returns true when no retry remains, and false (or rejects) to retry.
 * The owner keeps the participants and reads them when its connection task runs.
 * Cancellation prevents later scheduling; it cannot abort an already-running
 * task's underlying transport, which remains the task owner's responsibility.
 */
export class ConnectionRetryCoordinator {
  private readonly connections = new Map<string, ConnectionRetry>()
  private readonly delaysMs: readonly number[]
  private stopped = false

  constructor(delaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS) {
    if (
      delaysMs.length === 0 ||
      delaysMs.some((delay, index) => !Number.isSafeInteger(delay) || delay < 0 || (index > 0 && delay === 0)) ||
      delaysMs.at(-1) === 0
    ) {
      throw new RangeError('Connection retry delays must end with a positive delay and only the first may be zero.')
    }
    this.delaysMs = [...delaysMs]
  }

  get size(): number {
    return this.connections.size
  }

  has(connectionId: string): boolean {
    return this.connections.has(connectionId)
  }

  schedule(connectionId: string, task: RetryTask, immediate = false): void {
    if (this.stopped) return
    let retry = this.connections.get(connectionId)
    if (!retry) {
      retry = { task, attempt: 0, timer: null, running: false, requestedWhileRunning: false, immediateAfterRun: false }
      this.connections.set(connectionId, retry)
      this.setTimer(connectionId, retry, immediate ? 0 : this.delaysMs[0])
      return
    }

    // A later closure may include a newly added session. Do not keep an old
    // task that captured a superseded participant set until the next failure.
    retry.task = task
    if (retry.running) {
      retry.requestedWhileRunning = true
      if (immediate) retry.immediateAfterRun = true
      return
    }
    if (immediate) {
      retry.attempt = 0
      if (retry.timer) clearTimeout(retry.timer)
      this.setTimer(connectionId, retry, 0)
    }
  }

  cancel(connectionId: string): void {
    const retry = this.connections.get(connectionId)
    if (retry?.timer) clearTimeout(retry.timer)
    // Removing the entry also invalidates any still-running task's completion.
    this.connections.delete(connectionId)
  }

  shutdown(): void {
    this.stopped = true
    for (const connectionId of this.connections.keys()) this.cancel(connectionId)
  }

  private setTimer(connectionId: string, retry: ConnectionRetry, delay: number): void {
    retry.timer = setTimeout(() => {
      retry.timer = null
      void this.run(connectionId, retry)
    }, delay)
    retry.timer.unref()
  }

  private async run(connectionId: string, retry: ConnectionRetry): Promise<void> {
    if (this.stopped || this.connections.get(connectionId) !== retry) return
    retry.running = true
    retry.requestedWhileRunning = false
    retry.immediateAfterRun = false
    let completed = false
    try {
      completed = await retry.task()
    } catch {
      // Transport failures remain retryable. The connection task owns detailed
      // user-facing status and logs; rejection must not orphan the retry clock.
    }
    if (this.stopped || this.connections.get(connectionId) !== retry) return
    retry.running = false

    if (retry.immediateAfterRun || (completed && retry.requestedWhileRunning)) {
      retry.attempt = 0
      this.setTimer(connectionId, retry, 0)
    } else if (completed) {
      this.connections.delete(connectionId)
    } else {
      retry.attempt = Math.min(retry.attempt + 1, this.delaysMs.length - 1)
      this.setTimer(connectionId, retry, this.delaysMs[retry.attempt])
    }
  }
}
