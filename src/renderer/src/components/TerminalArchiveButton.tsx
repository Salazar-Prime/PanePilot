import { useLayoutEffect, useState, type RefObject } from 'react'
import { Archive } from 'lucide-react'
import '../terminal-archives.css'

/** This optional shortcut must never squeeze or truncate a terminal title. */
export function TerminalArchiveButton({ strip, revision, count, onClick }: {
  strip: RefObject<HTMLDivElement>
  revision: string
  count: number
  onClick(): void
}) {
  const [fits, setFits] = useState(false)
  useLayoutEffect(() => {
    const list = strip.current
    const bar = list?.parentElement
    if (!list || !bar) return
    const context = document.createElement('canvas').getContext('2d')
    let frame = 0
    const measure = () => {
      const needed = Array.from(list.children).reduce((total, child) => {
        const tab = child as HTMLElement
        const title = tab.querySelector<HTMLElement>('.terminal-tab-select > span:not(.status-chip)')
        let titleWidth = title?.scrollWidth ?? 0
        if (title && context) {
          const style = getComputedStyle(title)
          context.font = style.font
          titleWidth = Math.max(titleWidth, context.measureText(title.textContent ?? '').width +
            (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0))
        }
        // Measure the unwrapped title as well as clipped text: the optional
        // archive shortcut must not cause a formerly single-line title to wrap.
        return total + Math.max(tab.scrollWidth, tab.getBoundingClientRect().width) +
          (title ? Math.max(0, titleWidth - title.clientWidth) : 0)
      }, 0)
      const scrollbar = Math.max(0, list.getBoundingClientRect().width - list.clientWidth)
      setFits(bar.clientWidth >= needed + scrollbar + 60)
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    observer.observe(bar)
    observer.observe(list)
    for (const child of list.children) observer.observe(child)
    measure()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [strip, revision, count])
  return <button className="terminal-archive-shortcut" hidden={!fits} onClick={onClick}
    aria-label={`Archived terminals (${count})`} title={`${count} archived terminal${count === 1 ? '' : 's'}`}>
    <Archive size={14} /><span>{count > 99 ? '99+' : count}</span>
  </button>
}
