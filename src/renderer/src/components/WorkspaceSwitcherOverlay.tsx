import { useEffect, useRef, type CSSProperties } from 'react'
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
import { workspaceTerminalIndicator } from '../lib/workspaceHistory'
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
  const style = {
    '--workspace-switcher-index': selectedIndex
  } as CSSProperties
  const heading =
    mode === 'terminals'
      ? 'PROJECT TERMINALS'
      : mode === 'capabilities'
        ? 'PROJECT TOOLS'
        : 'RECENT WORK'

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [mode, selectedIndex])

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
        <div className="workspace-switcher-project-context">
          <span>PROJECT</span>
          <strong>{projectName ?? 'Selected project'}</strong>
          <small>
            {modifierLabel}← tools&nbsp;&nbsp;{modifierLabel}→ terminals
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
                ) : isRemovalTarget ? (
                  <kbd className="workspace-switcher-remove-hint">
                    D remove
                  </kbd>
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
            <small>Press {modifierLabel}← to choose a project tool.</small>
          </div>
        )}
      </div>
      <div className="workspace-switcher-footer" aria-hidden="true">
        <span>{modifierLabel}← tools</span>
        <span>{modifierLabel}→ terminals</span>
        {mode === 'recent' && <span>D removes hovered or selected item</span>}
        <span>release {modifierLabel} to open</span>
      </div>
    </div>
  )
}
