import { useEffect, useRef, useState } from 'react'
import { RefreshCw, WifiOff } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type {
  TerminalSession,
  TerminalTransportEvent
} from '@shared/types'

export function ManagedTerminal({ session }: { session: TerminalSession }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const dimensionsRef = useRef({ cols: 100, rows: 30 })
  const [transport, setTransport] = useState<TerminalTransportEvent>({
    sessionId: session.id,
    state: 'attached',
    attempt: 0,
    message: null
  })

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    setTransport({
      sessionId: session.id,
      state: 'attached',
      attempt: 0,
      message: null
    })

    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
      fontSize: 13,
      lineHeight: 1.32,
      letterSpacing: 0,
      scrollback: 5_000,
      allowProposedApi: true,
      theme: {
        background: '#090b10',
        foreground: '#d5d8df',
        cursor: '#8b9cff',
        cursorAccent: '#090b10',
        selectionBackground: '#5062b955',
        black: '#161923',
        red: '#ff667d',
        green: '#63d5a4',
        yellow: '#e8be72',
        blue: '#7398ff',
        magenta: '#b38cf5',
        cyan: '#63c6dc',
        white: '#d5d8df',
        brightBlack: '#626978',
        brightRed: '#ff8192',
        brightGreen: '#83e5bb',
        brightYellow: '#f2ce8b',
        brightBlue: '#91afff',
        brightMagenta: '#c8a7ff',
        brightCyan: '#84d8e9',
        brightWhite: '#f6f7fb'
      }
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    fit.fit()
    dimensionsRef.current = { cols: terminal.cols, rows: terminal.rows }

    let replaying = true
    let writable = true
    const dataDisposable = terminal.onData((data) => {
      if (!replaying && writable) {
        void window.projectConsole.terminals.write(session.id, data)
      }
    })
    const removeDataListener = window.projectConsole.terminals.onData((event) => {
      if (event.sessionId === session.id) terminal.write(event.data)
    })
    const removeTransportListener =
      window.projectConsole.terminals.onTransport((event) => {
        if (event.sessionId !== session.id) return
        writable = event.state === 'attached'
        setTransport(event)
      })

    void window.projectConsole.terminals
      .attach(session.id, terminal.cols, terminal.rows)
      .then(({ output }) => {
        terminal.write(output, () => {
          replaying = false
          terminal.focus()
        })
      })
      .catch((error) => {
        replaying = false
        writable = false
        setTransport({
          sessionId: session.id,
          state: 'offline',
          attempt: 0,
          message: String(error)
        })
        terminal.writeln(`\r\n\x1b[31mPanePilot: ${String(error)}\x1b[0m`)
      })

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      dimensionsRef.current = { cols: terminal.cols, rows: terminal.rows }
      void window.projectConsole.terminals.resize(session.id, terminal.cols, terminal.rows)
    })
    resizeObserver.observe(host)

    return () => {
      resizeObserver.disconnect()
      removeDataListener()
      removeTransportListener()
      dataDisposable.dispose()
      terminal.dispose()
    }
  }, [session.id])

  async function retry() {
    setTransport((current) => ({
      ...current,
      state: 'reconnecting',
      message: 'Retrying the existing tmux session…'
    }))
    try {
      await window.projectConsole.terminals.retryAttach(
        session.id,
        dimensionsRef.current.cols,
        dimensionsRef.current.rows
      )
    } catch (error) {
      setTransport({
        sessionId: session.id,
        state: 'offline',
        attempt: transport.attempt,
        message: String(error)
      })
    }
  }

  const interrupted = transport.state !== 'attached'

  return (
    <div className="managed-terminal">
      <div className="terminal-host" ref={hostRef} />
      {interrupted && (
        <div className={`terminal-transport-banner ${transport.state}`}>
          {transport.state === 'offline' ? (
            <WifiOff size={14} />
          ) : (
            <RefreshCw
              className={transport.state === 'reconnecting' ? 'spin' : ''}
              size={14}
            />
          )}
          <span>
            <strong>
              {transport.state === 'offline'
                ? 'Remote host offline'
                : transport.state === 'reconnecting'
                  ? 'Reconnecting'
                  : 'Terminal detached'}
            </strong>
            <small>{transport.message ?? 'Input is paused until tmux reconnects.'}</small>
          </span>
          {transport.state !== 'detached' && (
            <button onClick={() => void retry()}>
              <RefreshCw size={12} /> Retry now
            </button>
          )}
        </div>
      )}
    </div>
  )
}
