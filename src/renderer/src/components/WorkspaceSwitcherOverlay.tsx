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
import '../workspace-switcher.css'

interface WorkspaceSwitcherOverlayProps {
  destinations: WorkspaceDestination[]
  selectedIndex: number
  modifierLabel: string
  onSelect(index: number): void
}

function DestinationIcon({ tab }: { tab: WorkspaceTabId }) {
  if (tab === 'terminal') return <TerminalSquare size={16} />
  if (tab === 'manuscript') return <FileType2 size={16} />
  if (tab === 'pdf') return <FileText size={16} />
  if (tab === 'actions') return <Play size={16} />
  if (tab === 'qna') return <MessageCircleQuestion size={16} />
  if (tab === 'notes') return <FileText size={16} />
  if (tab === 'files') return <Files size={16} />
  if (tab === 'chats') return <MessageSquareText size={16} />
  if (tab === 'activity') return <History size={16} />
  return <Activity size={16} />
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
            <span className="workspace-switcher-icon">
              <DestinationIcon tab={destination.tab} />
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
            <kbd>{modifierLabel}−</kbd>
          </button>
        ))}
      </div>
    </div>
  )
}
