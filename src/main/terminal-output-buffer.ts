const DEFAULT_MAXIMUM_BYTES = 512 * 1024
const SEGMENT_CODE_UNITS = 4 * 1024

interface OutputSegment {
  text: string
  start: number
  byteLength: number
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** A byte-bounded replay tail; appending only visits new and evicted text. */
export class TerminalOutputBuffer {
  private segments: Array<OutputSegment | undefined> = []
  private head = 0
  private retainedBytes = 0

  constructor(private readonly maximumBytes = DEFAULT_MAXIMUM_BYTES) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
      throw new RangeError('Terminal output byte limit must be a nonnegative integer.')
    }
  }

  get byteLength(): number {
    return this.retainedBytes
  }

  get chunkCount(): number {
    return this.segments.length - this.head
  }

  append(data: string): void {
    if (!data || this.maximumBytes === 0) return

    // A single oversized write supersedes every retained segment. Copy its
    // bounded UTF-8 suffix so a small replay cannot pin the original input.
    if (Buffer.byteLength(data, 'utf8') > this.maximumBytes) {
      const encoded = Buffer.from(data, 'utf8')
      let start = encoded.length - this.maximumBytes
      while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1
      data = encoded.subarray(start).toString('utf8')
      this.clear()
    }

    let offset = 0
    const tail = this.segments[this.segments.length - 1]
    if (tail && data) {
      const joinsSurrogatePair =
        isHighSurrogate(tail.text.charCodeAt(tail.text.length - 1)) &&
        isLowSurrogate(data.charCodeAt(0))
      // Merge small writes only into this bounded tail, never the whole replay.
      // Permit one extra code unit when a surrogate pair straddles PTY writes.
      let take = Math.min(data.length, Math.max(0, SEGMENT_CODE_UNITS - tail.text.length))
      if (joinsSurrogatePair) take = Math.max(take, 1)
      if (
        take < data.length &&
        isHighSurrogate(data.charCodeAt(take - 1)) &&
        isLowSurrogate(data.charCodeAt(take))
      ) {
        take -= 1
      }
      if (take > 0) {
        const suffix = data.slice(0, take)
        const bytes = Buffer.byteLength(suffix, 'utf8') - (joinsSurrogatePair ? 2 : 0)
        tail.text += suffix
        tail.byteLength += bytes
        this.retainedBytes += bytes
        offset = take
      }
    }

    while (offset < data.length) {
      let end = Math.min(data.length, offset + SEGMENT_CODE_UNITS)
      if (
        end < data.length &&
        isHighSurrogate(data.charCodeAt(end - 1)) &&
        isLowSurrogate(data.charCodeAt(end))
      ) {
        end -= 1
      }
      const text = data.slice(offset, end)
      const byteLength = Buffer.byteLength(text, 'utf8')
      this.segments.push({ text, start: 0, byteLength })
      this.retainedBytes += byteLength
      offset = end
    }

    this.prune()
  }

  read(): string {
    const chunks: string[] = []
    for (let index = this.head; index < this.segments.length; index += 1) {
      const segment = this.segments[index]!
      chunks.push(segment.text.slice(segment.start))
    }
    return chunks.join('')
  }

  clear(): void {
    this.segments = []
    this.head = 0
    this.retainedBytes = 0
  }

  private prune(): void {
    while (this.retainedBytes > this.maximumBytes) {
      const segment = this.segments[this.head]!
      const excess = this.retainedBytes - this.maximumBytes
      if (segment.byteLength <= excess) {
        this.retainedBytes -= segment.byteLength
        // Release consumed strings immediately; compaction only moves indexes.
        this.segments[this.head++] = undefined
        continue
      }

      let discardedBytes = 0
      while (discardedBytes < excess) {
        const code = segment.text.charCodeAt(segment.start++)
        if (code <= 0x7f) discardedBytes += 1
        else if (code <= 0x7ff) discardedBytes += 2
        else if (
          isHighSurrogate(code) &&
          isLowSurrogate(segment.text.charCodeAt(segment.start))
        ) {
          segment.start += 1
          discardedBytes += 4
        } else discardedBytes += 3
      }
      segment.byteLength -= discardedBytes
      this.retainedBytes -= discardedBytes
      if (segment.byteLength === 0) this.segments[this.head++] = undefined
    }

    if (this.head === this.segments.length) this.clear()
    else if (this.head >= 64 && this.head * 2 >= this.segments.length) {
      this.segments = this.segments.slice(this.head)
      this.head = 0
    }
  }
}
