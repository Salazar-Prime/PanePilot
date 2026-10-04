import { useLayoutEffect, useRef, type RefObject } from 'react'
import { SidebarProjectMotion } from './sidebarProjectMotion'

export function useSidebarProjectMotion(containerRef: RefObject<HTMLElement>, visible: boolean, revision: unknown): void {
  const motionRef = useRef<SidebarProjectMotion | null>(null)
  if (!motionRef.current) motionRef.current = new SidebarProjectMotion()

  useLayoutEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const reset = () => motionRef.current?.reset()
    preference.addEventListener('change', reset)
    document.addEventListener('visibilitychange', reset)
    return () => {
      preference.removeEventListener('change', reset)
      document.removeEventListener('visibilitychange', reset)
      reset()
    }
  }, [])

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) { motionRef.current?.reset(); return }
    motionRef.current?.update(container, visible && !document.hidden &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  }, [containerRef, visible, revision])
}
