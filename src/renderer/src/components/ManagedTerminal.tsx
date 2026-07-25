import { useEffect, useRef, useState } from 'react'
import { RefreshCw, WifiOff } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type {
  TerminalSession,
  TerminalTransportEvent
} from '@shared/types'
import {
  terminalFileLinkProvider,
  type TerminalFileTarget
} from '../lib/terminalFileLinks'

interface Props {
  session: TerminalSession
  active?: boolean
  retainOutputOnExit?: boolean
  projectFolder?: string
  onOpenFile?(target: TerminalFileTarget): void
}

export function ManagedTerminal({
  session,
  active = true,
  retainOutputOnExit = false,
  projectFolder,
  onOpenFile
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const activeRef = useRef(active)
  activeRef.current = active
  const dimensionsRef = useRef({ cols: 100, rows: 30 })
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile
  const terminalEnded = ['completed', 'error'].includes(session.state)
  const retainedOutput =
    retainOutputOnExit && terminalEnded ? session.output : null
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
      cursorBlink: !terminalEnded,
      cursorStyle: 'bar',
      disableStdin: terminalEnded,
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
    terminalRef.current = terminal
    fitRef.current = fit
    fit.fit()
    dimensionsRef.current = { cols: terminal.cols, rows: terminal.rows }
    const linkDisposable =
      projectFolder && onOpenFileRef.current
        ? terminal.registerLinkProvider(
            terminalFileLinkProvider(terminal, projectFolder, (target) => {
              onOpenFileRef.current?.(target)
            })
          )
        : null

    if (retainedOutput !== null) {
      if (retainedOutput) {
        terminal.write(retainedOutput, () => terminal.scrollToBottom())
      }
      const resizeObserver = new ResizeObserver(() => {
        fit.fit()
        dimensionsRef.current = { cols: terminal.cols, rows: terminal.rows }
      })
      resizeObserver.observe(host)
      return () => {
        resizeObserver.disconnect()
        linkDisposable?.dispose()
        if (terminalRef.current === terminal) terminalRef.current = null
        if (fitRef.current === fit) fitRef.current = null
        terminal.dispose()
      }
    }

    let replaying = true
    let writable = !terminalEnded
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
        writable = !terminalEnded && event.state === 'attached'
        setTransport(event)
      })

    void window.projectConsole.terminals
      .attach(session.id, terminal.cols, terminal.rows)
      .then(({ output }) => {
        terminal.write(output, () => {
          replaying = false
          if (activeRef.current) terminal.focus()
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
      linkDisposable?.dispose()
      if (terminalRef.current === terminal) terminalRef.current = null
      if (fitRef.current === fit) fitRef.current = null
      terminal.dispose()
    }
  }, [session.id, terminalEnded, retainedOutput, projectFolder])

  useEffect(() => {
    if (!active) return
    const frame = window.requestAnimationFrame(() => {
      const terminal = terminalRef.current
      const fit = fitRef.current
      if (!terminal || !fit) return
      fit.fit()
      dimensionsRef.current = { cols: terminal.cols, rows: terminal.rows }
      void window.projectConsole.terminals.resize(
        session.id,
        terminal.cols,
        terminal.rows
      )
      terminal.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, session.id])

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

  const interrupted =
    transport.state !== 'attached' &&
    !(
      retainOutputOnExit &&
      (terminalEnded || transport.state === 'detached')
    )

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
          <button onClick={() => void retry()}>
            <RefreshCw size={12} />{' '}
            {transport.state === 'detached' ? 'Reattach' : 'Retry now'}
          </button>
        </div>
      )}
    </div>
  )
}
