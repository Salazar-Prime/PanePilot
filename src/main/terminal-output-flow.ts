export interface TerminalOutputConsumer {
  pause(): void
  resume(): void
  write(data: string, done: () => void): void
  onParsed?(): void
}

export interface TerminalOutputFlowLimits {
  highWaterMark?: number
  lowWaterMark?: number
  maxBatchBytes?: number
}

interface PendingChunk {
  text: string
  start: number
  bytes: number
}

/**
 * Applies PTY backpressure to an asynchronous terminal parser without dropping
 * or rewriting output. pendingBytes includes the write awaiting its callback.
 *
 * This is a flow-control threshold, not a limit that discards data: a producer
 * honoring pause before its next delivery can overshoot by one delivered chunk.
 * Bytes already buffered inside the native PTY are outside this queue's control.
 * Split input surrogate pairs are counted conservatively as two lone surrogates.
 */
export class TerminalOutputFlow {
  private readonly highWaterMark: number
  private readonly lowWaterMark: number
  private readonly maxBatchBytes: number
  private chunks: Array<PendingChunk | undefined> = []
  private head = 0
  private outstandingBytes = 0
  private producerPaused = false
  private writing = false
  private disposed = false
  private scheduled: NodeJS.Immediate | null = null

  constructor(
    private readonly consumer: TerminalOutputConsumer,
    limits: TerminalOutputFlowLimits = {}
  ) {
    this.highWaterMark = limits.highWaterMark ?? 256 * 1024
    this.lowWaterMark = limits.lowWaterMark ?? 64 * 1024
    this.maxBatchBytes = limits.maxBatchBytes ?? 64 * 1024
    if (
      !Number.isSafeInteger(this.highWaterMark) || this.highWaterMark <= 0 ||
      !Number.isSafeInteger(this.lowWaterMark) || this.lowWaterMark < 0 ||
      this.lowWaterMark >= this.highWaterMark ||
      !Number.isSafeInteger(this.maxBatchBytes) || this.maxBatchBytes < 4
    ) {
      throw new RangeError('Terminal output flow requires 0 <= low < high and a batch of at least 4 bytes.')
    }
  }

  get pendingBytes(): number {
    return this.outstandingBytes
  }

  get paused(): boolean {
    return this.producerPaused
  }

  enqueue(data: string): void {
    if (this.disposed || data.length === 0) return
    const bytes = Buffer.byteLength(data, 'utf8')
    this.chunks.push({ text: data, start: 0, bytes })
    this.outstandingBytes += bytes
    if (!this.producerPaused && this.outstandingBytes >= this.highWaterMark) {
      this.producerPaused = true
      this.consumer.pause()
    }
    this.scheduleWrite()
  }

  /** The owner is closing the transport; never resume it from a late callback. */
  dispose(): void {
    this.disposed = true
    if (this.scheduled) clearImmediate(this.scheduled)
    this.scheduled = null
    this.chunks = []
    this.head = 0
    this.outstandingBytes = 0
    this.writing = false
  }

  private scheduleWrite(): void {
    if (this.disposed || this.writing || this.scheduled || this.outstandingBytes === 0) return
    // Yield between batches even when a consumer invokes its callback inline.
    // This also coalesces tiny synchronous native deliveries into one write.
    this.scheduled = setImmediate(() => {
      this.scheduled = null
      if (this.disposed) return
      const batch = this.takeBatch()
      this.writing = true
      let completed = false
      this.consumer.write(batch.text, () => {
        if (completed || this.disposed) return
        completed = true
        this.writing = false
        this.outstandingBytes -= batch.bytes
        if (this.producerPaused && this.outstandingBytes <= this.lowWaterMark) {
          this.producerPaused = false
          this.consumer.resume()
        }
        this.scheduleWrite()
        this.consumer.onParsed?.()
      })
    })
  }

  private takeBatch(): { text: string; bytes: number } {
    const parts: string[] = []
    let bytes = 0
    while (this.head < this.chunks.length && bytes < this.maxBatchBytes) {
      const chunk = this.chunks[this.head]!
      const available = this.maxBatchBytes - bytes
      if (chunk.bytes <= available) {
        parts.push(chunk.text.slice(chunk.start))
        bytes += chunk.bytes
        this.chunks[this.head++] = undefined
        continue
      }

      let end = chunk.start
      let takenBytes = 0
      while (end < chunk.text.length) {
        const code = chunk.text.charCodeAt(end)
        const next = chunk.text.charCodeAt(end + 1)
        const paired = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
        const characterBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : paired ? 4 : 3
        if (takenBytes + characterBytes > available) break
        takenBytes += characterBytes
        end += paired ? 2 : 1
      }
      if (end === chunk.start) break
      parts.push(chunk.text.slice(chunk.start, end))
      chunk.start = end
      chunk.bytes -= takenBytes
      bytes += takenBytes
    }

    if (this.head === this.chunks.length) {
      this.chunks = []
      this.head = 0
    } else if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head)
      this.head = 0
    }
    return { text: parts.join(''), bytes }
  }
}
