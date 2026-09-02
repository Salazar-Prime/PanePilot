import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  RefreshCw,
  WifiOff
} from 'lucide-react'
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
import { terminalWebLinkProvider } from '../lib/terminalWebLinks'
import {
  clipboardPasteFits,
  decodeOsc52Clipboard,
  prepareClipboardPaste,
  terminalPastePayload
} from '../lib/terminalClipboard'
import { registerSpeechContent } from '../lib/speechContent'

interface Props {
  session: TerminalSession
  active?: boolean
  retainOutputOnExit?: boolean
  projectFolder?: string
  onOpenFile?(target: TerminalFileTarget): void
}

const terminalAttachCounts = new Map<string, number>()

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
  const writableRef = useRef(false)
  const replayingRef = useRef(true)
  const dimensionsRef = useRef({ cols: 100, rows: 30 })
  const onOpenFileRef = useRef(onOpenFile)
  onOpenFileRef.current = onOpenFile
  const terminalEnded = ['completed', 'error'].includes(session.state)
  const terminalEndedRef = useRef(terminalEnded)
  terminalEndedRef.current = terminalEnded
  const [transport, setTransport] = useState<TerminalTransportEvent>({
    sessionId: session.id,
    state: 'attached',
    attempt: 0,
    message: null
  })
  const transportRef = useRef(transport)
  transportRef.current = transport
  const [inputReady, setInputReady] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    top: number
    left: number
  } | null>(null)

  async function copySelection(): Promise<void> {
    setContextMenu(null)
    const selection = terminalRef.current?.getSelection() ?? ''
    if (selection) await window.projectConsole.system.copyText(selection)
  }

  async function pasteClipboard(): Promise<void> {
    setContextMenu(null)
    const terminal = terminalRef.current
    if (!terminal || !activeRef.current || !writableRef.current) return
    try {
      const text = prepareClipboardPaste(
        await window.projectConsole.system.readText()
      )
      if (
        terminalRef.current !== terminal ||
        !activeRef.current ||
        !writableRef.current
      ) {
        window.alert('Terminal input is no longer available.')
        return
      }
      if (!text) return
      const payload = terminalPastePayload(
        text,
        terminal.modes.bracketedPasteMode
      )
      if (!clipboardPasteFits(payload)) {
        window.alert('Clipboard paste is limited to 2 MB.')
        return
      }
      await window.projectConsole.terminals.write(session.id, payload)
      terminal.scrollToBottom()
      terminal.focus()
    } catch (error) {
      window.alert(
        `Could not paste clipboard: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }

  async function copyFullBuffer(): Promise<void> {
    setContextMenu(null)
    try {
      const output = await window.projectConsole.terminals.captureBuffer(
        session.id
      )
      await window.projectConsole.system.copyText(output)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    writableRef.current = false
    replayingRef.current = true
    setInputReady(false)
    setContextMenu(null)
    const initialTransport: TerminalTransportEvent = {
      sessionId: session.id,
      state: 'attached',
      attempt: 0,
      message: null
    }
    transportRef.current = initialTransport
    setTransport(initialTransport)

    const openUrl = (url: string): void => {
      void window.projectConsole.system.openExternal(url).catch((error) => {
        console.error('Could not open terminal URL.', error)
      })
    }
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
      macOptionClickForcesSelection: true,
      linkHandler: {
        activate(event, url) {
          event.preventDefault()
          openUrl(url)
        },
        allowNonHttpProtocols: false
      },
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
    const unregisterSpeechContent = registerSpeechContent(session.id, () => {
      const buffer = terminal.buffer.active
      const end = Math.min(buffer.length, buffer.viewportY + terminal.rows)
      let visibleText = ''
      for (let index = buffer.viewportY; index < end; index += 1) {
        const line = buffer.getLine(index)
        if (!line) continue
        const content = line.translateToString(true)
        visibleText += line.isWrapped ? content : `${visibleText ? '\n' : ''}${content}`
      }
      return {
        selectedText: terminal.getSelection().trim(),
        visibleText: visibleText.trim()
      }
    })
    const linkDisposable =
      projectFolder && onOpenFileRef.current
        ? terminal.registerLinkProvider(
            terminalFileLinkProvider(terminal, projectFolder, (target) => {
              onOpenFileRef.current?.(target)
            })
          )
        : null
    const webLinkDisposable = terminal.registerLinkProvider(
      terminalWebLinkProvider(terminal, openUrl)
    )
    let replaying = true
    let writable = !terminalEndedRef.current
    const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
      const clipboardText = decodeOsc52Clipboard(data)
      if (clipboardText !== null && activeRef.current) {
        void window.projectConsole.system.copyText(clipboardText)
      }
      return true
    })
    terminal.attachCustomKeyEventHandler((event) => {
      const key = event.key.toLocaleLowerCase()
      const copyShortcut =
        (event.metaKey && key === 'c') ||
        (event.ctrlKey && event.shiftKey && key === 'c')
      const pasteShortcut =
        (event.metaKey && key === 'v') ||
        (event.ctrlKey && event.shiftKey && key === 'v') ||
        (event.shiftKey && event.key === 'Insert')
      if (!copyShortcut && !pasteShortcut) return true
      event.preventDefault()
      event.stopPropagation()
      if (event.type === 'keydown' && !event.repeat) {
        if (copyShortcut) {
          if (terminal.hasSelection()) {
            void copySelection()
          } else if (event.metaKey && writableRef.current) {
            void window.projectConsole.terminals.write(session.id, '\x03')
          }
        } else if (writableRef.current) {
          void pasteClipboard()
        }
      }
      return false
    })

    const dataDisposable = terminal.onData((data) => {
      if (
        activeRef.current &&
        !terminalEndedRef.current &&
        !replaying &&
        writable
      ) {
        void window.projectConsole.terminals.write(session.id, data).catch(
          (error) => console.error('Could not write terminal input.', error)
        )
      }
    })
    const removeDataListener = window.projectConsole.terminals.onData((event) => {
      if (event.sessionId === session.id) terminal.write(event.data)
    })
    const removeTransportListener =
      window.projectConsole.terminals.onTransport((event) => {
        if (event.sessionId !== session.id) return
        writable = !terminalEndedRef.current && event.state === 'attached'
        transportRef.current = event
        writableRef.current = writable && !replaying && activeRef.current
        setInputReady(writableRef.current)
        setTransport(event)
      })

    const attachStartedAt = performance.now()
    const attachCount = (terminalAttachCounts.get(session.id) ?? 0) + 1
    terminalAttachCounts.set(session.id, attachCount)
    void window.projectConsole.terminals
      .attach(session.id, terminal.cols, terminal.rows)
      .then(({ output }) => {
        terminal.write(output, () => {
          replaying = false
          replayingRef.current = false
          writable = !terminalEndedRef.current && writable
          writableRef.current = writable && activeRef.current
          setInputReady(writableRef.current)
          if (activeRef.current) terminal.focus()
          if (import.meta.env.DEV) {
            console.debug('[PanePilot performance] terminal ready', {
              sessionId: session.id,
              attachCount,
              durationMs: Math.round(performance.now() - attachStartedAt)
            })
            const selectionName = `panepilot:terminal-select:${session.id}`
            const selectionMark = performance
              .getEntriesByName(selectionName, 'mark')
              .at(-1)
            if (selectionMark && activeRef.current) {
              console.debug('[PanePilot performance] terminal focused', {
                sessionId: session.id,
                durationMs: Math.round(
                  performance.now() - selectionMark.startTime
                ),
                warm: false
              })
              performance.clearMarks(selectionName)
            }
          }
        })
      })
      .catch((error) => {
        replaying = false
        replayingRef.current = false
        writable = false
        writableRef.current = false
        setInputReady(false)
        setTransport({
          sessionId: session.id,
          state: 'offline',
          attempt: 0,
          message: String(error)
        })
        transportRef.current = {
          sessionId: session.id,
          state: 'offline',
          attempt: 0,
          message: String(error)
        }
        terminal.writeln(`\r\n\x1b[31mPanePilot: ${String(error)}\x1b[0m`)
      })

    const resizeObserver = new ResizeObserver(() => {
      if (!activeRef.current) return
      fit.fit()
      dimensionsRef.current = { cols: terminal.cols, rows: terminal.rows }
      void window.projectConsole.terminals.resize(session.id, terminal.cols, terminal.rows)
    })
    resizeObserver.observe(host)

    return () => {
      unregisterSpeechContent()
      resizeObserver.disconnect()
      removeDataListener()
      removeTransportListener()
      dataDisposable.dispose()
      linkDisposable?.dispose()
      webLinkDisposable.dispose()
      osc52Disposable.dispose()
      writableRef.current = false
      if (terminalRef.current === terminal) terminalRef.current = null
      if (fitRef.current === fit) fitRef.current = null
      terminal.dispose()
    }
  }, [session.id, projectFolder])

  useEffect(() => {
    const terminal = terminalRef.current
    if (terminal) {
      terminal.options.cursorBlink = !terminalEnded
      terminal.options.disableStdin = terminalEnded
    }
    if (terminalEnded) {
      writableRef.current = false
      setInputReady(false)
    }
  }, [terminalEnded])

  useEffect(() => {
    if (!active) {
      writableRef.current = false
      setInputReady(false)
      return
    }
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
      const ready =
        !replayingRef.current &&
        !terminalEndedRef.current &&
        transportRef.current.state === 'attached'
      writableRef.current = ready
      setInputReady(ready)
      terminal.focus()
      if (import.meta.env.DEV && ready) {
        const name = `panepilot:terminal-select:${session.id}`
        const mark = performance.getEntriesByName(name, 'mark').at(-1)
        if (mark) {
          console.debug('[PanePilot performance] terminal focused', {
            sessionId: session.id,
            durationMs: Math.round(performance.now() - mark.startTime),
            warm: (terminalAttachCounts.get(session.id) ?? 0) === 1
          })
          performance.clearMarks(name)
        }
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [active, session.id])

  useEffect(() => {
    if (!active) setContextMenu(null)
  }, [active, session.id])

  useEffect(() => {
    if (!contextMenu) return
    function closeMenu(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (!target.closest('.terminal-clipboard-menu')) setContextMenu(null)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setContextMenu(null)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [contextMenu])

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
    <div
      className="managed-terminal"
      data-speech-terminal-id={session.id}
      data-terminal-session-id={session.id}
    >
      <div
        className="terminal-host"
        ref={hostRef}
        onContextMenu={(event) => {
          event.preventDefault()
          setContextMenu({
            top: Math.min(event.clientY, window.innerHeight - 130),
            left: Math.min(event.clientX, window.innerWidth - 190)
          })
        }}
      />
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
      {contextMenu &&
        createPortal(
          <div
            className="popover-menu terminal-clipboard-menu"
            style={{ top: contextMenu.top, left: contextMenu.left }}
          >
            <button
              disabled={!terminalRef.current?.hasSelection()}
              onClick={() => void copySelection()}
            >
              <Copy size={14} /> Copy selection
            </button>
            <button
              disabled={!inputReady}
              onClick={() => void pasteClipboard()}
            >
              <ClipboardPaste size={14} /> Paste
            </button>
            <button
              disabled={session.backend !== 'tmux' || !session.tmuxName}
              onClick={() => void copyFullBuffer()}
            >
              <ClipboardCopy size={14} /> Copy full tmux buffer
            </button>
          </div>,
          document.body
        )}
    </div>
  )
}
