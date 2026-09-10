import { useLayoutEffect, useRef, type CSSProperties } from 'react'
import {
  Activity,
  FileText,
  Files,
  FileType2,
  Flag,
  History,
  MessageCircleQuestion,
  MessageSquareText,
  Play,
  TerminalSquare
} from 'lucide-react'
import type {
  WorkspaceDestination,
  WorkspaceTabId
} from '../lib/workspaceHistory'
import { nextWorkspaceSwitcherMode, workspaceTerminalIndicator } from '../lib/workspaceHistory'
import '../workspace-switcher.css'

interface WorkspaceSwitcherOverlayProps {
  destinations: WorkspaceDestination[]
  selectedIndex: number
  modifierLabel: string
  mode: 'recent' | 'terminals' | 'capabilities'
  projectName?: string
  currentKey: string | null
  hoveredKey: string | null
  removingKey: string | null
  onHoverKey(key: string | null): void
}

function DestinationIcon({ tab }: { tab: WorkspaceTabId }) {
  if (tab === 'terminal') return <TerminalSquare size={11} />
  if (tab === 'manuscript') return <FileType2 size={11} />
  if (tab === 'pdf') return <FileText size={11} />
  if (tab === 'actions') return <Play size={11} />
  if (tab === 'qna') return <MessageCircleQuestion size={11} />
  if (tab === 'notes') return <FileText size={11} />
  if (tab === 'files') return <Files size={11} />
  if (tab === 'chats') return <MessageSquareText size={11} />
  if (tab === 'activity') return <History size={11} />
  return <Activity size={11} />
}

function ProjectGlyph({ destination }: { destination: WorkspaceDestination }) {
  if (destination.projectIcon) return destination.projectIcon
  if (destination.projectType === 'latex') return <FileType2 size={17} />
  return destination.projectName.slice(0, 1).toUpperCase()
}

function TerminalIndicator({
  destination
}: {
  destination: WorkspaceDestination
}) {
  const indicator = workspaceTerminalIndicator(destination)
  if (!indicator) return null
  const label = indicator === 'working' ? 'Working' : 'Needs attention'
  return (
    <span
      className={`workspace-switcher-status ${indicator}`}
      aria-label={label}
      title={label}
    >
      <i aria-hidden="true" />
      <span>{indicator === 'working' ? 'Working' : 'Attention'}</span>
    </span>
  )
}

function TerminalSignals({
  destination
}: {
  destination: WorkspaceDestination
}) {
  return (
    <span className="workspace-switcher-signals">
      {destination.terminalFlagged && (
        <span
          className="workspace-switcher-flag"
          aria-label="Flagged terminal"
          title="Flagged terminal"
        >
          <Flag size={9} fill="currentColor" />
          <span>Flagged</span>
        </span>
      )}
      <TerminalIndicator destination={destination} />
    </span>
  )
}

export function WorkspaceSwitcherOverlay({
  destinations,
  selectedIndex,
  modifierLabel,
  mode,
  projectName,
  currentKey,
  hoveredKey,
  removingKey,
  onHoverKey
}: WorkspaceSwitcherOverlayProps) {
  const listRef = useRef<HTMLDivElement>(null)
  const projectContextRef = useRef<HTMLDivElement>(null)
  const transitionRef = useRef<{
    view: string
    origin: { x: number; y: number } | null
  } | null>(null)
  const animationsRef = useRef<Animation[]>([])
  const modeLabels = { recent: 'history', capabilities: 'tools', terminals: 'terminals' }
  const previousView = modeLabels[nextWorkspaceSwitcherMode(mode, -1)]
  const nextView = modeLabels[nextWorkspaceSwitcherMode(mode, 1)]
  const style = {
    '--workspace-switcher-index': selectedIndex
  } as CSSProperties
  const heading =
    mode === 'terminals'
      ? 'PROJECT TERMINALS'
      : mode === 'capabilities'
        ? 'PROJECT TOOLS'
        : 'RECENT WORK'

  useLayoutEffect(() => {
    // Finish measuring the destination layout before applying visual transforms.
    // The previous selected project glyph is the origin of the next view.
    for (const animation of animationsRef.current) animation.cancel()
    animationsRef.current = []
    const list = listRef.current
    if (!list) return
    const selected = list.querySelector<HTMLElement>('[aria-selected="true"]')
    if (selected) {
      const viewport = list.getBoundingClientRect()
      const bounds = selected.getBoundingClientRect()
      if (bounds.top < viewport.top) list.scrollTop += bounds.top - viewport.top
      else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom
    }
    const previous = transitionRef.current
    const view = `${mode}:${projectName ?? ''}`
    const source = (mode === 'recent'
      ? selected?.querySelector('.workspace-switcher-project-glyph')
      : projectContextRef.current) ?? selected
    const sourceBounds = source?.getBoundingClientRect()
    transitionRef.current = {
      view,
      origin: sourceBounds
        ? { x: sourceBounds.left + 17, y: sourceBounds.top + sourceBounds.height / 2 }
        : null
    }
    if (
      !previous?.origin || previous.view === view || removingKey ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) return

    const viewport = list.getBoundingClientRect()
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.workspace-switcher-option'))
      .filter((row) => {
        const bounds = row.getBoundingClientRect()
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom
      })
    const origin = previous.origin
    const context = projectContextRef.current
    const entering = context ? [context, ...rows] : rows
    for (const [index, element] of entering.entries()) {
      const bounds = element.getBoundingClientRect()
      const x = origin.x - bounds.left
      const y = origin.y - (bounds.top + bounds.height / 2)
      const animation = element.animate([
        {
          transform: `translate(${x}px, ${y}px) scale(0.18, 0.35)`,
          transformOrigin: '0 50%',
          opacity: 0
        },
        { transform: 'translate(0, 0) scale(1)', transformOrigin: '0 50%', opacity: 1 }
      ], {
        duration: mode === 'recent' ? 220 : 280,
        delay: Math.min(index, 7) * 16,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: 'backwards'
      })
      animationsRef.current.push(animation)
    }
    return () => {
      for (const animation of animationsRef.current) animation.cancel()
      animationsRef.current = []
    }
  }, [mode, projectName, selectedIndex, removingKey])

  return (
    <div
      className={`workspace-switcher-overlay mode-${mode}`}
      role="presentation"
      data-testid="workspace-switcher"
    >
      <div className="workspace-switcher-header">
        <span>{heading}</span>
        <small>{modifierLabel}↑↓ to choose</small>
      </div>
      {mode !== 'recent' && (
        <div className="workspace-switcher-project-context" ref={projectContextRef}>
          <span>PROJECT</span>
          <strong>{projectName ?? 'Selected project'}</strong>
          <small>
            {modifierLabel}← {previousView}&nbsp;&nbsp;{modifierLabel}→ {nextView}
          </small>
        </div>
      )}
      <div
        className={`workspace-switcher-list ${
          mode === 'recent' ? '' : 'drilldown'
        }`}
        role="listbox"
        aria-label={heading.toLocaleLowerCase()}
        style={style}
        ref={listRef}
        onMouseMove={(event) => {
          const option =
            event.target instanceof Element
              ? event.target.closest<HTMLElement>(
                  '[data-workspace-option-index]'
                )
              : null
          const hoveredIndex = Number(option?.dataset.workspaceOptionIndex)
          const destination = Number.isInteger(hoveredIndex)
            ? destinations[hoveredIndex]
            : null
          onHoverKey(
            mode === 'recent'
              ? destination?.key ?? null
              : null
          )
        }}
        onMouseLeave={() => onHoverKey(null)}
        onScroll={() => onHoverKey(null)}
      >
        {destinations.length > 0 && (
          <div className="workspace-switcher-glass" aria-hidden="true" />
        )}
        {destinations.map((destination, index) => {
          const isCurrent =
            mode === 'recent' && destination.key === currentKey
          const isRemovalTarget =
            mode === 'recent' &&
            !isCurrent &&
            destination.key === (hoveredKey ?? destinations[selectedIndex]?.key)
          return (
            <div
              key={destination.key}
              className={`workspace-switcher-option ${
                isCurrent ? 'is-current' : ''
              } ${isRemovalTarget ? 'is-removal-target' : ''} ${
                destination.key === removingKey ? 'is-removing' : ''
              }`}
              role="option"
              aria-selected={index === selectedIndex}
              aria-current={isCurrent ? 'page' : undefined}
              data-workspace-option-index={index}
            >
              <span
                className="workspace-switcher-project-icon"
                aria-hidden="true"
              >
                <span className="workspace-switcher-project-glyph">
                  <ProjectGlyph destination={destination} />
                </span>
                <span
                  className={`workspace-switcher-sub-icon tab-${destination.tab}`}
                >
                  <DestinationIcon tab={destination.tab} />
                </span>
              </span>
              <span className="workspace-switcher-copy">
                <strong
                  className={destination.sessionName ? 'workspace-switcher-session-title' : undefined}
                  title={destination.sessionName ?? destination.tabLabel}
                >
                  {destination.sessionName ?? destination.tabLabel}
                </strong>
                <small>
                  {destination.projectName}
                  {destination.sessionName
                    ? ` · ${destination.tabLabel}`
                    : ''}
                </small>
              </span>
              <span className="workspace-switcher-trailing">
                <TerminalSignals destination={destination} />
                {isCurrent ? (
                  <span className="workspace-switcher-current-label">
                    Current
                  </span>
                ) : (
                  <kbd>{modifierLabel}↑↓</kbd>
                )}
              </span>
            </div>
          )
        })}
        {destinations.length === 0 && (
          <div className="workspace-switcher-empty">
            <TerminalSquare size={18} />
            <strong>No terminals in this project</strong>
            <small>Press {modifierLabel}← or {modifierLabel}→ to change views.</small>
          </div>
        )}
      </div>
      <div className="workspace-switcher-footer" aria-hidden="true">
        <span>{modifierLabel}← {previousView}</span>
        <span>{modifierLabel}→ {nextView}</span>
        <span>release {modifierLabel} to open</span>
      </div>
    </div>
  )
}
