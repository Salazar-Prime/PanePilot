import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

const STORAGE_KEY = 'panepilot.workspace-split-ratio.v1'
const normalize = (ratio: number) => Number.isFinite(ratio) ? Math.max(0.2, Math.min(0.8, ratio)) : 0.5

export function WorkspaceSplit({ open, children }: { open: boolean; children: [ReactNode, ReactNode] }) {
  const root = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      return saved === null ? 0.5 : normalize(Number(saved))
    } catch { return 0.5 }
  })
  const preferred = useRef(ratio)
  const [width, setWidth] = useState(0)
  const [resizing, setResizing] = useState(false)
  const drag = useRef<{ pointerId: number; x: number; leftWidth: number; original: number; handle: HTMLDivElement } | null>(null)
  // Keep both workspaces usable, but allow smaller windows to share space evenly.
  const minimum = width > 0 ? Math.min(0.5, Math.max(0.2, 280 / width)) : 0.2
  const visibleRatio = Math.max(minimum, Math.min(1 - minimum, ratio))

  function update(value: number) {
    preferred.current = normalize(value)
    setRatio(preferred.current)
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, String(preferred.current)) } catch { /* Resizing still works without storage. */ }
  }

  function finish() {
    const current = drag.current
    if (!current) return
    drag.current = null
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId)
    save()
    setResizing(false)
  }

  useLayoutEffect(() => {
    const element = root.current!
    const measure = () => setWidth(element.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const hide = () => { if (document.hidden) finish() }
    const release = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointerId) finish() }
    // Also finish outside the moving grip if Chromium releases pointer capture.
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    window.addEventListener('blur', finish)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      window.removeEventListener('blur', finish)
      document.removeEventListener('visibilitychange', hide)
      finish()
    }
  }, [])

  useEffect(() => { if (!open) finish() }, [open])

  function reset() { finish(); update(0.5); save() }

  return <div ref={root} className={`workspace-split${open ? ' split' : ''}${resizing ? ' split-resizing' : ''}`}
    style={{ '--workspace-left-width': `${visibleRatio * 100}%` } as CSSProperties}>
    {children[0]}
    {open && <div className="workspace-split-resizer" role="separator" aria-label="Resize workspace split"
      aria-orientation="vertical" aria-valuemin={Math.round(minimum * 100)} aria-valuemax={Math.round((1 - minimum) * 100)}
      aria-valuenow={Math.round(visibleRatio * 100)} aria-valuetext={`Left pane ${Math.round(visibleRatio * 100)}%, right pane ${Math.round((1 - visibleRatio) * 100)}%`}
      tabIndex={0} title="Drag to resize panes · Arrow keys adjust · Double-click to balance"
      onPointerDown={(event) => {
        if (event.button !== 0 || drag.current) return
        event.preventDefault()
        event.currentTarget.focus({ preventScroll: true })
        drag.current = { pointerId: event.pointerId, x: event.clientX,
          leftWidth: root.current!.firstElementChild!.getBoundingClientRect().width,
          original: preferred.current, handle: event.currentTarget }
        event.currentTarget.setPointerCapture(event.pointerId)
        setResizing(true)
      }}
      onPointerMove={(event) => {
        const current = drag.current
        if (!current || current.pointerId !== event.pointerId) return
        const available = root.current!.getBoundingClientRect().width
        if (!available) return
        const min = Math.min(0.5, Math.max(0.2, 280 / available))
        update(Math.max(min, Math.min(1 - min, (current.leftWidth + event.clientX - current.x) / available)))
      }}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} onDoubleClick={reset}
      onKeyDown={(event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) return
        const step = event.shiftKey ? 0.05 : 0.02
        let next: number
        if (event.key === 'ArrowLeft') next = visibleRatio - step
        else if (event.key === 'ArrowRight') next = visibleRatio + step
        else if (event.key === 'Home') next = minimum
        else if (event.key === 'End') next = 1 - minimum
        else if (event.key === 'Enter') next = 0.5
        else if (event.key === 'Escape' && drag.current) {
          event.preventDefault(); event.stopPropagation(); update(drag.current.original); finish(); return
        } else return
        event.preventDefault()
        event.stopPropagation()
        update(Math.max(minimum, Math.min(1 - minimum, next)))
        save()
      }} />}
    {children[1]}
  </div>
}
