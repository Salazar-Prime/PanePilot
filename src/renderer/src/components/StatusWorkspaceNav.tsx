import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** The focused workspace owns the single tools slot in the fixed-height footer. */
export function StatusWorkspaceNav({
  active,
  children
}: {
  active: boolean
  children: ReactNode
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null)

  useLayoutEffect(() => {
    setTarget(document.getElementById('status-workspace-nav'))
  }, [])

  return active && target ? createPortal(children, target) : null
}
