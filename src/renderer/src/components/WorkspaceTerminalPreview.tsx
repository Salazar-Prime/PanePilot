import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { TerminalSquare } from 'lucide-react'
import type { TerminalPreviewSnapshot } from '@shared/types'
import type { WorkspaceDestination } from '../lib/workspaceHistory'
import { previewScale } from '../lib/workspaceTerminalPreview'
import { terminalTheme } from '../lib/terminalTheme'
import { safeTerminalText } from '../lib/subagentTerminal'

function PreviewScreen({ snapshot }: { snapshot: TerminalPreviewSnapshot }) {
  const frame = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!host.current || !frame.current) return
    const terminal = new Terminal({
      cols: snapshot.cols, rows: snapshot.rows, scrollback: 0,
      disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none',
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
      fontSize: 13, lineHeight: 1.32, convertEol: true, theme: terminalTheme
    })
    terminal.open(host.current)
    host.current.inert = true
    let disposed = false
    let animation = 0
    const fit = () => {
      cancelAnimationFrame(animation)
      animation = requestAnimationFrame(() => {
        if (disposed || !frame.current || !host.current) return
        const screen = host.current.querySelector<HTMLElement>('.xterm-screen')
        if (!screen?.offsetWidth || !screen.offsetHeight) return
        host.current.style.width = `${screen.offsetWidth}px`
        host.current.style.height = `${screen.offsetHeight}px`
        const scale = previewScale(frame.current.clientWidth, frame.current.clientHeight, screen.offsetWidth, screen.offsetHeight)
        host.current.style.transform = `translate(-50%, -50%) scale(${scale})`
        host.current.style.opacity = '1'
      })
    }
    terminal.write(safeTerminalText(snapshot.output) + '\x1b[0m', fit)
    const observer = new ResizeObserver(fit)
    observer.observe(frame.current)
    const screen = host.current.querySelector('.xterm-screen')
    if (screen) observer.observe(screen)
    return () => { disposed = true; cancelAnimationFrame(animation); observer.disconnect(); terminal.dispose() }
  }, [snapshot])
  return <div className="workspace-preview-screen" ref={frame} aria-hidden="true"><div className="workspace-preview-surface" ref={host} /></div>
}

export function WorkspaceTerminalPreview({ destination }: { destination: WorkspaceDestination }) {
  const [snapshot, setSnapshot] = useState<TerminalPreviewSnapshot | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      if (disposed || document.hidden) return
      try {
        const result = await window.projectConsole.terminals.preview(destination.sessionId!)
        if (!disposed) {
          setSnapshot((previous) => previous?.output === result.output && previous.cols === result.cols && previous.rows === result.rows ? previous : result)
          setError('')
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : 'Preview unavailable.')
      } finally {
        if (!disposed) timer = setTimeout(read, 1500)
      }
    }
    // Browsing through a row quickly must not issue a new SSH capture for it.
    timer = setTimeout(read, 150)
    return () => { disposed = true; clearTimeout(timer) }
  }, [destination.sessionId])

  return createPortal(
    <section className="workspace-terminal-preview" aria-label={`Terminal preview: ${destination.sessionName}`}>
      <header><TerminalSquare size={16} /><div><strong>{destination.sessionName}</strong><small>{destination.projectName}</small></div><span>Preview</span></header>
      {snapshot ? <PreviewScreen snapshot={snapshot} /> : <div className="workspace-preview-message">{error || 'Reading terminal screen…'}</div>}
      <footer>{error && snapshot ? 'Last snapshot · host currently unavailable' : snapshot?.source === 'buffer' ? 'Buffered screen · read-only' : 'Screen snapshot · release modifier to switch'}</footer>
    </section>, document.body
  )
}
