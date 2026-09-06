import type { CSSProperties } from 'react'
import {
  Activity,
  FileText,
  Files,
  FileType2,
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
  onSelect(index: number): void
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

export function WorkspaceSwitcherOverlay({
  destinations,
  selectedIndex,
  modifierLabel,
  onSelect
}: WorkspaceSwitcherOverlayProps) {
  const style = {
    '--workspace-switcher-index': selectedIndex
  } as CSSProperties

  return (
    <div
      className="workspace-switcher-overlay"
      role="presentation"
      data-testid="workspace-switcher"
    >
      <div className="workspace-switcher-header">
        <span>RECENT WORK</span>
        <small>Release {modifierLabel} to open</small>
      </div>
      <div
        className="workspace-switcher-list"
        role="listbox"
        aria-label="Recent workspaces"
        style={style}
      >
        <div className="workspace-switcher-glass" aria-hidden="true" />
        {destinations.map((destination, index) => (
          <button
            key={destination.key}
            type="button"
            className="workspace-switcher-option"
            role="option"
            aria-selected={index === selectedIndex}
            onMouseEnter={() => onSelect(index)}
            onClick={() => onSelect(index)}
          >
            <span className="workspace-switcher-project-icon" aria-hidden="true">
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
              <strong>
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
              <TerminalIndicator destination={destination} />
              <kbd>{modifierLabel}−</kbd>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
