import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { terminalTheme } from '../lib/terminalTheme'

/** A display-only terminal: no PTY attachment, input IPC, links, or clipboard handlers. */
export function SubagentTerminal({ transcript, name }: { transcript: string; name: string }) {
  const host = useRef<HTMLDivElement>(null)
  const update = useRef<((value: string) => void) | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const following = useRef(true)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    if (!host.current) return
    const terminal = new Terminal({
      disableStdin: true, cursorBlink: false, cursorInactiveStyle: 'none',
      fontFamily: '"SFMono-Regular", "Cascadia Code", "Liberation Mono", monospace',
      fontSize: 10, lineHeight: 1.2, scrollback: 5000, convertEol: true,
      theme: terminalTheme, allowProposedApi: true
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host.current)
    terminalRef.current = terminal
    let disposed = false
    let writing = false
    let rendered = ''
    let requested = ''
    let frame = 0
    const pump = () => {
      if (disposed || writing || requested === rendered) return
      writing = true
      const next = requested
      const wasFollowing = following.current
      const position = terminal.buffer.active.viewportY
      const append = next.startsWith(rendered)
      const data = append ? next.slice(rendered.length) : next
      if (!append) terminal.reset()
      terminal.write(data, () => {
        if (disposed) return
        rendered = next
        if (wasFollowing) terminal.scrollToBottom()
        else terminal.scrollToLine(position)
        writing = false
        pump()
      })
    }
    update.current = (value) => { requested = value; pump() }
    const syncFollow = () => {
      if (writing) return
      following.current = terminal.buffer.active.baseY - terminal.buffer.active.viewportY <= 1
      setFollow(following.current)
    }
    const onScroll = terminal.onScroll(syncFollow)
    // xterm suppresses its public onScroll event for native viewport scrolling.
    const viewport = host.current.querySelector('.xterm-viewport')
    viewport?.addEventListener('scroll', syncFollow)
    const resize = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (disposed || !host.current?.clientWidth || !host.current.clientHeight) return
        const position = terminal.buffer.active.viewportY
        const wasFollowing = following.current
        fit.fit()
        if (wasFollowing) terminal.scrollToBottom()
        else terminal.scrollToLine(position)
      })
    }
    const observer = new ResizeObserver(resize)
    observer.observe(host.current)
    resize()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      onScroll.dispose()
      viewport?.removeEventListener('scroll', syncFollow)
      update.current = null
      terminalRef.current = null
      terminal.dispose()
    }
  }, [])

  useEffect(() => { update.current?.(transcript) }, [transcript])

  return <>
    <div className="subagent-output subagent-terminal" ref={host} role="region" aria-label={`${name} terminal output`} />
    {!follow && <button className="subagent-follow" onClick={() => {
      following.current = true
      setFollow(true)
      terminalRef.current?.scrollToBottom()
    }}>Jump to latest</button>}
  </>
}
