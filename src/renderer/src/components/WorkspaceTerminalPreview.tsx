import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { TerminalSquare } from 'lucide-react'
import type { TerminalPreviewSnapshot } from '@shared/types'
import type { WorkspaceDestination } from '../lib/workspaceHistory'
import { previewFontSize } from '../lib/workspaceTerminalPreview'
import { terminalTheme } from '../lib/terminalTheme'
import { safeTerminalText } from '../lib/subagentTerminal'

interface LoadedPreview { snapshot: TerminalPreviewSnapshot; destination: WorkspaceDestination }

function PreviewScreen({ preview, onReady }: { preview: LoadedPreview | null; onReady(preview: LoadedPreview): void }) {
  const frame = useRef<HTMLDivElement>(null)
  const hosts = useRef<Array<HTMLDivElement | null>>([])
  const update = useRef<((value: LoadedPreview | null) => void) | null>(null)
  const ready = useRef(onReady)
  ready.current = onReady
  useEffect(() => {
    if (!frame.current || !hosts.current[0] || !hosts.current[1]) return
    // Two persistent surfaces: prepare the next screen invisibly, then swap in
    // one frame. Never reset/dispose the visible screen during a refresh.
    const terminals = hosts.current.map((host) => {
      const terminal = new Terminal({
        cols: 80, rows: 24, scrollback: 0,
        disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none',
        fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
        fontSize: 13, lineHeight: 1.32, convertEol: true, theme: terminalTheme
      })
      terminal.open(host!)
      host!.inert = true
      host!.style.opacity = '0'
      return terminal
    })
    let disposed = false
    let animation = 0
    let front = -1
    let requested: LoadedPreview | null = null
    let version = 0
    let paintedVersion = -1
    let drawing = false
    const paint = () => {
      if (disposed || drawing || !requested || paintedVersion === version || !frame.current) return
      drawing = true
      const next = requested
      const generation = version
      const back = front === 0 ? 1 : 0
      const terminal = terminals[back]
      const host = hosts.current[back]!
      terminal.options.fontSize = previewFontSize(frame.current.clientWidth, frame.current.clientHeight, next.snapshot.cols, next.snapshot.rows)
      terminal.resize(next.snapshot.cols, next.snapshot.rows)
      terminal.reset()
      terminal.write(safeTerminalText(next.snapshot.output) + '\x1b[0m', () => {
        const finish = (attempt = 0) => {
          if (disposed) return
          if (generation !== version || !frame.current) { drawing = false; paint(); return }
          const screen = host.querySelector<HTMLElement>('.xterm-screen')
          if (!screen?.offsetWidth || !screen.offsetHeight) {
            // A hidden/zero-size window must not spin forever; a later resize
            // or snapshot will retry while the last good surface stays intact.
            if (attempt >= 16) { drawing = false; return }
            animation = requestAnimationFrame(() => finish(attempt + 1))
            return
          }
          if (attempt < 16 && terminal.options.fontSize! > 1 &&
            (screen.offsetWidth > frame.current.clientWidth || screen.offsetHeight > frame.current.clientHeight)) {
            terminal.options.fontSize = terminal.options.fontSize! - 1
            animation = requestAnimationFrame(() => finish(attempt + 1))
            return
          }
          host.style.width = `${screen.offsetWidth}px`
          host.style.height = `${screen.offsetHeight}px`
          host.style.opacity = '1'
          if (front >= 0) hosts.current[front]!.style.opacity = '0'
          front = back
          paintedVersion = generation
          drawing = false
          ready.current(next)
          paint()
        }
        // Allow xterm's own scheduled DOM render to complete before revealing it.
        if (!disposed) animation = requestAnimationFrame(() => {
          animation = requestAnimationFrame(() => finish())
        })
      })
    }
    update.current = (value) => { requested = value; version++; paint() }
    const observer = new ResizeObserver(() => { version++; paint() })
    observer.observe(frame.current)
    return () => { disposed = true; update.current = null; cancelAnimationFrame(animation); observer.disconnect(); terminals.forEach((terminal) => terminal.dispose()) }
  }, [])
  useEffect(() => { update.current?.(preview) }, [preview])
  return <div className="workspace-preview-screen" ref={frame} aria-hidden="true">
    {[0, 1].map((slot) => <div key={slot} className="workspace-preview-surface" ref={(node) => { hosts.current[slot] = node }} />)}
  </div>
}

export function WorkspaceTerminalPreview({ destination }: { destination: WorkspaceDestination }) {
  const [loaded, setLoaded] = useState<LoadedPreview | null>(null)
  const [shown, setShown] = useState<LoadedPreview | null>(null)
  const [failure, setFailure] = useState<{ sessionId: string; message: string } | null>(null)
  const error = failure?.sessionId === destination.sessionId ? failure.message : ''
  const loadingNext = shown?.destination.sessionId !== destination.sessionId
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      if (disposed || document.hidden) return
      try {
        const result = await window.projectConsole.terminals.preview(destination.sessionId!)
        if (!disposed) {
          setLoaded((previous) => previous?.destination.sessionId === destination.sessionId &&
            previous.snapshot.output === result.output && previous.snapshot.cols === result.cols && previous.snapshot.rows === result.rows
            ? previous : { snapshot: result, destination })
          setFailure(null)
        }
      } catch (cause) {
        if (!disposed) setFailure({ sessionId: destination.sessionId!, message: cause instanceof Error ? cause.message : 'Preview unavailable.' })
      } finally {
        if (!disposed) timer = setTimeout(read, 1500)
      }
    }
    // Browsing through a row quickly must not issue a new SSH capture for it.
    timer = setTimeout(read, 150)
    return () => { disposed = true; clearTimeout(timer) }
  }, [destination.sessionId])

  return createPortal(
    <section className="workspace-terminal-preview" aria-label={`Terminal preview: ${(shown?.destination ?? destination).sessionName}`}>
      <header><TerminalSquare size={16} /><div><strong>{(shown?.destination ?? destination).sessionName}</strong><small>{(shown?.destination ?? destination).projectName}</small></div><span>Preview</span></header>
      <PreviewScreen preview={loaded?.destination.sessionId === destination.sessionId ? loaded : null} onReady={setShown} />
      {!shown && <div className="workspace-preview-message">{error || 'Reading terminal screen…'}</div>}
      <footer>{loadingNext && shown ? `${error ? 'Preview unavailable for' : 'Loading'} ${destination.sessionName} · showing ${shown.destination.sessionName}` :
        error && shown ? 'Last snapshot · host currently unavailable' : shown?.snapshot.source === 'buffer' ? 'Buffered screen · read-only' : 'Screen snapshot · release modifier to switch'}</footer>
    </section>, document.body
  )
}
