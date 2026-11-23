import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { Check } from 'lucide-react'
import type { Project } from '@shared/types'

interface Notice {
  id: string
  name: string
  project: string
}

/** One app-wide listener, independent of the selected project, pane, or run entry point. */
export function ActionCompletionNotice({ projects, activeProjectId }: {
  projects: Project[]
  activeProjectId: string | null
}) {
  const [notices, setNotices] = useState<Notice[]>([])
  const [placement, setPlacement] = useState({ left: 0, bottom: 0 })
  const projectsRef = useRef(projects)
  projectsRef.current = projects
  const seen = useRef(new Set<string>())
  const reducedMotion = useReducedMotion()

  useEffect(() => window.projectConsole.terminals.onState((event) => {
    if (event.state !== 'completed' || event.actionCompletion?.exitCode !== 0 || seen.current.has(event.sessionId)) return
    seen.current.add(event.sessionId)
    if (seen.current.size > 256) seen.current.delete(seen.current.values().next().value!)
    // Do not replay notifications on foreground return or for archived/deleted projects.
    const project = projectsRef.current.find((item) => item.id === event.projectId && !item.archived)
    if (document.hidden || !project) return
    const notice = { id: event.sessionId, name: event.actionCompletion.name, project: project.name }
    setNotices((current) => [...current.slice(-2), notice])
  }), [])

  useEffect(() => {
    const hidden = () => { if (document.hidden) setNotices([]) }
    document.addEventListener('visibilitychange', hidden)
    return () => document.removeEventListener('visibilitychange', hidden)
  }, [])

  useLayoutEffect(() => {
    if (!notices.length) return
    const place = () => {
      const anchor = document.querySelector('[data-action-completion-anchor]') ?? document.getElementById('status-workspace-nav')
      if (!anchor) return
      const rect = anchor.getBoundingClientRect()
      const halfWidth = Math.min(310, window.innerWidth - 24) / 2
      setPlacement({
        left: Math.max(halfWidth + 12, Math.min(window.innerWidth - halfWidth - 12, rect.left + rect.width / 2)),
        bottom: window.innerHeight - rect.top + 8
      })
    }
    place()
    const observer = new ResizeObserver(place)
    const footer = document.querySelector('.status-bar')
    if (footer) observer.observe(footer)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [notices, activeProjectId])

  return createPortal(<div className="action-completion-notices" style={placement}
    role="status" aria-live="polite" aria-relevant="additions" aria-atomic="false">
    {notices.map((notice) => <motion.div className="action-completion-pill" key={notice.id}
      data-run-id={notice.id}
      initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
      animate={{ opacity: [0, 1, 1, 0], y: reducedMotion ? 0 : [12, -4, -12, -32] }}
      transition={{ duration: 2.8, times: [0, 0.12, 0.72, 1], ease: 'easeOut' }}
      onAnimationComplete={() => setNotices((current) => current.filter((item) => item.id !== notice.id))}>
      <span className="action-completion-check"><Check size={13} strokeWidth={2.5} /></span>
      <span className="action-completion-copy"><strong>Run complete</strong><span>{notice.name} · {notice.project}</span></span>
    </motion.div>)}
  </div>, document.body)
}
