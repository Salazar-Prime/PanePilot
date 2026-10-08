import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { animateSidebarDisclosure } from '../lib/sidebarDisclosure'

export function SidebarSessionTree({ open, children }: { open: boolean; children: ReactNode }) {
  const shell = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const initial = useRef(true)
  const [present, setPresent] = useState(open)
  useLayoutEffect(() => {
    const element = shell.current!
    element.inert = !open
    if (initial.current) {
      initial.current = false
      element.style.height = open ? 'auto' : '0px'
      return
    }
    if (!content.current) return
    if (open) setPresent(true)
    return animateSidebarDisclosure(element, content.current, open, () => setPresent(open))
  }, [open])
  return <div className="sidebar-session-disclosure" data-expanded={open} aria-hidden={!open} ref={shell}>
    <div className="sidebar-session-content" ref={content}>{(open || present) && children}</div>
  </div>
}
