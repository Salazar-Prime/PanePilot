import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalSession } from '@shared/types'

export function ManagedTerminal({ session }: { session: TerminalSession }) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

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

    let replaying = true
    const dataDisposable = terminal.onData((data) => {
      if (!replaying) void window.projectConsole.terminals.write(session.id, data)
    })
    const removeDataListener = window.projectConsole.terminals.onData((event) => {
      if (event.sessionId === session.id) terminal.write(event.data)
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
        terminal.writeln(`\r\n\x1b[31mPanePilot: ${String(error)}\x1b[0m`)
      })

    const resizeObserver = new ResizeObserver(() => {
      fit.fit()
      void window.projectConsole.terminals.resize(session.id, terminal.cols, terminal.rows)
    })
    resizeObserver.observe(host)

    return () => {
      resizeObserver.disconnect()
      removeDataListener()
      dataDisposable.dispose()
      terminal.dispose()
    }
  }, [session.id])

  return <div className="terminal-host" ref={hostRef} />
}
