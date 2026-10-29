import type { ProjectConsoleApi } from '@shared/types'

type OutputBridge = Pick<ProjectConsoleApi['terminals'],
  'attach' | 'onData' | 'acknowledgeOutput' | 'unsubscribeOutput'>

interface Options {
  bridge: OutputBridge
  sessionId: string
  cols: number
  rows: number
  write(data: string, parsed: () => void): void
  onReady(): void
  onError(error: unknown): void
  consumerId?: string
}

/**
 * A surface owns its output credit until xterm has parsed each write. Main holds
 * live data behind the replay acknowledgement, so there is no pre-attach queue
 * here and replay always precedes live output, including in split panes.
 */
export function subscribeTerminalOutput({
  bridge, sessionId, cols, rows, write, onReady, onError,
  consumerId = crypto.randomUUID()
}: Options): () => void {
  let disposed = false
  let generation: string | null = null
  let sequence = 0
  let replayParsed = false
  let removeListener: (() => void) | null = null

  const unsubscribe = (): void => {
    bridge.unsubscribeOutput(sessionId, consumerId)
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    removeListener?.()
    removeListener = null
    unsubscribe()
  }
  const fail = (error: unknown): void => {
    if (disposed) return
    dispose()
    onError(error)
  }
  const acknowledge = (deliveredGeneration: string, deliveredSequence: number): void => {
    if (disposed || generation !== deliveredGeneration) return
    bridge.acknowledgeOutput(sessionId, consumerId, deliveredGeneration, deliveredSequence)
  }

  removeListener = bridge.onData((event) => {
    if (disposed || event.sessionId !== sessionId || event.consumerId !== consumerId) return
    if (generation === null) {
      fail(new Error('Terminal output arrived before its replay was ready. Reattach the terminal.'))
      return
    }
    if (event.generation !== generation) return
    const deliveredSequence = event.sequence
    if (typeof deliveredSequence !== 'number' || !Number.isSafeInteger(deliveredSequence) || deliveredSequence <= 0) return
    if (deliveredSequence <= sequence) return
    if (!replayParsed || deliveredSequence !== sequence + 1) {
      fail(new Error('Terminal output was interrupted. Reattach the terminal to restore its display.'))
      return
    }
    sequence = deliveredSequence
    const deliveredGeneration = generation
    try {
      write(event.data, () => acknowledge(deliveredGeneration, deliveredSequence))
    } catch (error) {
      fail(error)
    }
  })

  void bridge.attach(sessionId, cols, rows, consumerId).then((result) => {
    if (disposed) {
      // An asynchronous attach can finish after unmount's first unsubscribe.
      // Release that late registration as well; never write into a dead xterm.
      unsubscribe()
      return
    }
    if (!result.generation || result.sequence !== 0) {
      fail(new Error('Terminal output subscription is unavailable. Restart PanePilot.'))
      return
    }
    generation = result.generation
    const replayGeneration = generation
    try {
      write(result.output, () => {
        if (disposed || generation !== replayGeneration || replayParsed) return
        replayParsed = true
        onReady()
        acknowledge(replayGeneration, 0)
      })
    } catch (error) {
      fail(error)
    }
  }).catch(fail)

  return dispose
}
