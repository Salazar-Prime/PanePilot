import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

const STORAGE_KEY = 'panepilot.markdown-viewer-size.v1'
const DEFAULT_SIZE = { width: 1080, height: 760 }
type Size = typeof DEFAULT_SIZE

export function useMarkdownViewerResize(panel: RefObject<HTMLElement>) {
  const [size, setSize] = useState<Size>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      if (saved && Number.isFinite(saved.width) && saved.width > 0 && Number.isFinite(saved.height) && saved.height > 0) {
        return { width: Math.max(560, saved.width), height: Math.max(320, saved.height) }
      }
    } catch { /* A layout preference must not prevent opening the viewer. */ }
    return DEFAULT_SIZE
  })
  const [resizing, setResizing] = useState(false)
  const latest = useRef(size)
  const drag = useRef<{ pointerId: number; x: number; y: number; size: Size; handle: HTMLButtonElement } | null>(null)

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(latest.current)) } catch { /* Keep the in-memory size. */ }
  }

  function finish() {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId)
    persist()
    setResizing(false)
  }

  useEffect(() => {
    window.addEventListener('blur', finish)
    return () => { window.removeEventListener('blur', finish); finish() }
  }, [])

  function update(next: Size) {
    const maxWidth = Math.max(1, window.innerWidth - 48)
    const maxHeight = Math.max(1, window.innerHeight - 64)
    latest.current = {
      width: Math.min(maxWidth, Math.max(560, next.width)),
      height: Math.min(maxHeight, Math.max(320, next.height))
    }
    setSize(latest.current)
  }

  function reset() {
    finish()
    latest.current = DEFAULT_SIZE
    setSize(DEFAULT_SIZE)
    persist()
  }

  return {
    resizing,
    style: { '--markdown-viewer-width': `${size.width}px`, '--markdown-viewer-height': `${size.height}px` } as CSSProperties,
    handle: {
      onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
        if (event.button !== 0 || drag.current || !panel.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        const { width, height } = panel.current.getBoundingClientRect()
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, size: { width, height }, handle: event.currentTarget }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
      },
      onPointerMove(event: React.PointerEvent<HTMLButtonElement>) {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        // The dialog stays centered, so each edge moves by half the size change.
        update({ width: current.size.width + 2 * (event.clientX - current.x), height: current.size.height + 2 * (event.clientY - current.y) })
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onDoubleClick: reset,
      onClick(event: React.MouseEvent<HTMLButtonElement>) { if (event.detail === 0) reset() },
      onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Home') { reset(); return }
        const bounds = panel.current?.getBoundingClientRect()
        if (!bounds) return
        const step = event.shiftKey ? 40 : 10
        update({ width: bounds.width + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0),
          height: bounds.height + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0) })
        persist()
      }
    }
  }
}
