import { Keyboard } from 'lucide-react'
import type {
  ProjectShortcutAction,
  ProjectShortcutSession
} from '../lib/projectShortcuts'
import '../shortcut-overlay.css'

interface GuideProps {
  open: boolean
  projectName: string
  actions: ProjectShortcutAction[]
  sessions: ProjectShortcutSession[]
  activeSessionId: string | null
}

export function ProjectShortcutGuide({
  open,
  projectName,
  actions,
  sessions,
  activeSessionId
}: GuideProps) {
  if (!open) return null
  const primary = navigator.platform.toLocaleLowerCase().includes('mac')
    ? '⌘'
    : 'Ctrl+'
  return (
    <aside
      className="shortcut-command-overlay"
      role="status"
      aria-label={`Keyboard shortcuts for ${projectName}`}
    >
      <header>
        <span className="shortcut-command-mark">
          <Keyboard size={15} />
        </span>
        <div>
          <small>KEY ROUTING</small>
          <strong>{projectName}</strong>
        </div>
        <span className="shortcut-command-dismiss"><kbd>esc</kbd> hide</span>
      </header>
      <div className="shortcut-command-row">
        <b>Project tools</b>
        <div>
          {actions.map((action) => (
            <span className={action.active ? 'active' : ''} key={action.key}>
              <kbd>{action.key.toLocaleUpperCase()}</kbd>
              {action.label}
            </span>
          ))}
        </div>
      </div>
      {sessions.length > 0 && (
        <div className="shortcut-command-row">
          <b>Active tabs</b>
          <div>
            {sessions.slice(0, 9).map((session, index) => (
              <span
                className={session.id === activeSessionId ? 'active' : ''}
                key={session.id}
              >
                <kbd>{index + 1}</kbd>
                {session.label}
              </span>
            ))}
          </div>
        </div>
      )}
      <footer>
        <span>
          <kbd>{primary}/</kbd> toggle
        </span>
        <span>
          <kbd>{primary}1–9</kbd> jump directly
        </span>
        <span>
          <kbd>{primary}⇧[</kbd>
          <kbd>{primary}⇧]</kbd> cycle
        </span>
      </footer>
    </aside>
  )
}

export function ShortcutKeytip({
  value,
  open
}: {
  value: string
  open: boolean
}) {
  if (!open) return null
  return (
    <kbd className="shortcut-keytip" aria-hidden="true">
      {value}
    </kbd>
  )
}

export function ShortcutGuideButton({
  open,
  onClick
}: {
  open: boolean
  onClick(): void
}) {
  const primary = navigator.platform.toLocaleLowerCase().includes('mac')
    ? '⌘'
    : 'Ctrl+'
  return (
    <button
      className={`shortcut-guide-button ${open ? 'open' : ''}`}
      onClick={onClick}
      aria-pressed={open}
      title={`Show keyboard shortcuts (${primary}/)`}
    >
      <Keyboard size={14} />
      <span>Shortcuts</span>
      <kbd>{primary}/</kbd>
    </button>
  )
}
