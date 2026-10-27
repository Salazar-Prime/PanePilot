import { useLayoutEffect, useRef } from 'react'

/** Reveal only inside the tab strip, never scrolling the workspace or sidebar. */
export function useActiveTabVisibility(activeKey: string | null | undefined, revision: string) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const strip = ref.current
    if (!strip) return
    let frame = 0
    const reveal = () => {
      if (!strip.clientWidth) return
      const active = strip.querySelector<HTMLElement>('[data-active-tab="true"]')
      if (!active) return
      const viewport = strip.getBoundingClientRect()
      const bounds = active.getBoundingClientRect()
      const left = viewport.left + strip.clientLeft
      const right = left + strip.clientWidth
      if (bounds.left < left) strip.scrollLeft += bounds.left - left
      else if (bounds.right > right) strip.scrollLeft += bounds.right - right
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(reveal) }
    const observer = new ResizeObserver(schedule)
    observer.observe(strip)
    const active = strip.querySelector<HTMLElement>('[data-active-tab="true"]')
    if (active) observer.observe(active)
    reveal()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [activeKey, revision])
  return ref
}
