import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  Clipboard,
  Files,
  History,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import type { TerminalSession } from '@shared/types'
import type { ProjectWorkspaceProps } from '../projectTypeRegistry'
import {
  sessionSortOptions,
  sortSessions,
  useSessionSort
} from '../lib/sessionSort'
import { ChatHistoryPanel } from './ChatHistoryPanel'
import { FilesPanel } from './FilesPanel'
import { HistoryPanel } from './HistoryPanel'
import { ManagedTerminal } from './ManagedTerminal'
import { RenameDialog } from './RenameDialog'
import { StatusDot } from './StatusDot'
import { TerminalLauncher } from './TerminalLauncher'

type WorkspaceTab = 'terminal' | 'files' | 'chats' | 'history'

export function TerminalProjectWorkspace({
  project,
  selectedSessionId,
  launchTerminalRequest,
  onSelectSession,
  onChanged
}: ProjectWorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>('terminal')
  const [showLauncher, setShowLauncher] = useState(false)
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)
  const [sessionSort, setSessionSort] = useSessionSort()
  const [renameTarget, setRenameTarget] = useState<TerminalSession | null>(null)
  const [menu, setMenu] = useState<{ sessionId: string; top: number; left: number } | null>(
    null
  )
  const visibleSessions = useMemo(
    () =>
      sortSessions(
        project.sessions.filter((session) => !session.archived),
        sessionSort
      ),
    [project.sessions, sessionSort]
  )
  const archivedSessions = useMemo(
    () => project.sessions.filter((session) => session.archived),
    [project.sessions]
  )
  const activeSession =
    visibleSessions.find((session) => session.id === selectedSessionId) ?? visibleSessions[0]

  useEffect(() => {
    if (!activeSession) return
    if (activeSession.id !== selectedSessionId) onSelectSession(activeSession.id)
    void window.projectConsole.terminals.acknowledge(activeSession.id).then(onChanged)
  }, [activeSession?.id])

  useEffect(() => {
    if (launchTerminalRequest > 0) setShowLauncher(true)
  }, [launchTerminalRequest])

  useEffect(() => {
    if (!menu) return
    function closeMenu(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (!target.closest('.terminal-menu-portal, .tab-menu-button')) setMenu(null)
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', closeMenu)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeMenu)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [menu])

  async function selectSession(id: string) {
    setTab('terminal')
    onSelectSession(id)
    await window.projectConsole.terminals.acknowledge(id)
    await onChanged()
  }

  async function startTerminal(input: Parameters<typeof window.projectConsole.terminals.start>[0]) {
    const session = await window.projectConsole.terminals.start(input)
    setTab('terminal')
    onSelectSession(session.id)
    await onChanged()
  }

  async function rename(session: TerminalSession) {
    setMenu(null)
    setRenameTarget(session)
  }

  async function applyRename(name: string) {
    if (!renameTarget) return
    await window.projectConsole.terminals.rename(renameTarget.id, name)
    await onChanged()
  }

  async function togglePin(session: TerminalSession) {
    setMenu(null)
    await window.projectConsole.terminals.setPinned(session.id, !session.pinned)
    await onChanged()
  }

  async function stop(session: TerminalSession) {
    setMenu(null)
    if (!window.confirm(`Stop “${session.name}”? Its saved output will be kept.`)) return
    await window.projectConsole.terminals.stop(session.id)
    await onChanged()
  }

  async function archive(session: TerminalSession) {
    setMenu(null)
    await window.projectConsole.terminals.archive(session.id)
    await onChanged()
  }

  async function resumeAgent(session: TerminalSession) {
    setMenu(null)
    await window.projectConsole.terminals.resumeAgent(session.id)
    setTab('terminal')
    onSelectSession(session.id)
    await onChanged()
  }

  async function restore(session: TerminalSession) {
    await window.projectConsole.terminals.restore(session.id)
    if (archivedSessions.length === 1) setShowArchivedSessions(false)
    onSelectSession(session.id)
    await onChanged()
  }

  async function permanentlyDelete(session: TerminalSession) {
    if (
      !window.confirm(
        `Permanently delete “${session.name}” and its saved terminal output? Agent conversation archives will not be deleted.`
      )
    )
      return
    await window.projectConsole.terminals.delete(session.id)
    await onChanged()
  }

  function run(action: Promise<void>) {
    void action.catch((caught: unknown) => {
      window.alert(caught instanceof Error ? caught.message : String(caught))
    })
  }

  return (
    <div className="project-workspace">
      <nav className="workspace-tabs" aria-label="Project tools">
        <button className={tab === 'terminal' ? 'active' : ''} onClick={() => setTab('terminal')}>
          <TerminalSquare size={15} />
          Terminals
        </button>
        <button className={tab === 'files' ? 'active' : ''} onClick={() => setTab('files')}>
          <Files size={15} />
          Files
        </button>
        <button className={tab === 'chats' ? 'active' : ''} onClick={() => setTab('chats')}>
          <MessageSquareText size={15} />
          LLM Chats
        </button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>
          <History size={15} />
          Activity
        </button>
      </nav>

      {tab === 'terminal' && (
        <section className="terminal-workspace">
          <div className="terminal-tabs">
            <div className="terminal-tabs-scroll">
              {visibleSessions.map((session) => (
                <div
                  key={session.id}
                  className={`terminal-tab ${activeSession?.id === session.id ? 'active' : ''}`}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setMenu({
                      sessionId: session.id,
                      top: event.clientY,
                      left: event.clientX
                    })
                  }}
                >
                  <button
                    className="terminal-tab-select"
                    onClick={() => void selectSession(session.id)}
                  >
                    <StatusDot state={session.state} compact />
                    {session.pinned && <Pin className="pinned-indicator" size={10} />}
                    <span>{session.name}</span>
                    {session.dangerousMode && <small className="unsafe-badge">unsafe</small>}
                  </button>
                  <button
                    className="tab-menu-button"
                    aria-label={`Actions for ${session.name}`}
                    onClick={(event) => {
                      const bounds = event.currentTarget.getBoundingClientRect()
                      setMenu((current) =>
                        current?.sessionId === session.id
                          ? null
                          : {
                              sessionId: session.id,
                              top: bounds.bottom + 5,
                              left: Math.max(8, bounds.right - 150)
                            }
                      )
                    }}
                  >
                    <MoreHorizontal size={14} />
                  </button>
                </div>
              ))}
            </div>
            <label className="session-sort-control" title="Sort terminal sessions">
              <span>Sort</span>
              <select
                value={sessionSort}
                onChange={(event) =>
                  setSessionSort(
                    event.target.value as Parameters<typeof setSessionSort>[0]
                  )
                }
              >
                {sessionSortOptions.map((option) => (
                  <option value={option.value} key={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {archivedSessions.length > 0 && (
              <button
                className="session-archive-button"
                onClick={() => setShowArchivedSessions(true)}
                title="Archived terminals"
              >
                <Archive size={14} />
                <span>{archivedSessions.length}</span>
              </button>
            )}
            <button
              className="new-terminal-button"
              onClick={() => setShowLauncher(true)}
              title="New terminal"
            >
              <Plus size={16} />
            </button>
          </div>

          {activeSession ? (
            <div className="terminal-surface">
              <ManagedTerminal session={activeSession} />
            </div>
          ) : (
            <div className="terminal-empty">
              <div className="empty-orbit">
                <TerminalSquare size={31} />
              </div>
              <span className="eyebrow">READY WHEN YOU ARE</span>
              <h2>Start your first terminal</h2>
              <p>
                Run a shell, Codex, Claude Code, or any custom command in{' '}
                <strong>{project.name}</strong>.
              </p>
              <button className="primary-button" onClick={() => setShowLauncher(true)}>
                <Plus size={16} /> New terminal
              </button>
              {archivedSessions.length > 0 && (
                <div className="archived-list">
                  <span>{archivedSessions.length} archived</span>
                  {archivedSessions.map((session) => (
                    <div key={session.id}>
                      <span>{session.name}</span>
                      <button onClick={() => run(restore(session))}>
                        <RotateCcw size={13} /> Restore
                      </button>
                      <button
                        className="danger-text"
                        onClick={() => run(permanentlyDelete(session))}
                      >
                        <Trash2 size={13} /> Delete
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      )}
      {tab === 'files' && <FilesPanel project={project} />}
      {tab === 'chats' && <ChatHistoryPanel project={project} />}
      {tab === 'history' && <HistoryPanel project={project} />}
      {menu &&
        createPortal(
          <div
            className="popover-menu terminal-menu-portal"
            style={{ top: menu.top, left: menu.left }}
          >
            {(() => {
              const session = visibleSessions.find((item) => item.id === menu.sessionId)
              if (!session) return null
              const providerSessionReference =
                session.providerSessionId ?? session.providerSessionName
              return (
                <>
                  <button onClick={() => run(rename(session))}>
                    <Pencil size={14} /> Rename
                  </button>
                  <button onClick={() => run(togglePin(session))}>
                    {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    {session.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  {providerSessionReference && (
                    <button
                      onClick={() =>
                        run(
                          window.projectConsole.system.copyText(
                            providerSessionReference
                          )
                        )
                      }
                    >
                      <Clipboard size={14} />
                      {session.providerSessionId
                        ? 'Copy Codex session ID'
                        : 'Copy Codex session name'}
                    </button>
                  )}
                  {!['completed', 'error'].includes(session.state) ? (
                    <button className="danger-text" onClick={() => run(stop(session))}>
                      <Square size={13} /> Stop
                    </button>
                  ) : (
                    <>
                      {['codex', 'claude'].includes(session.profile) &&
                        providerSessionReference && (
                        <button onClick={() => run(resumeAgent(session))}>
                          <RotateCcw size={14} /> Resume{' '}
                          {session.profile === 'claude' ? 'Claude' : 'Codex'} chat
                        </button>
                      )}
                      <button onClick={() => run(archive(session))}>
                        <Archive size={14} /> Archive
                      </button>
                      <button
                        className="danger-text"
                        onClick={() => run(permanentlyDelete(session))}
                      >
                        <Trash2 size={14} /> Delete
                      </button>
                    </>
                  )}
                </>
              )
            })()}
          </div>,
          document.body
        )}
      {showLauncher && (
        <TerminalLauncher
          projectId={project.id}
          onClose={() => setShowLauncher(false)}
          onStart={startTerminal}
        />
      )}
      {renameTarget && (
        <RenameDialog
          title={`Rename ${renameTarget.name}`}
          eyebrow="TERMINAL NAME"
          label="Terminal and tmux session name"
          initialValue={renameTarget.name}
          description="PanePilot will rename the terminal and its tmux session together."
          maxLength={80}
          onClose={() => setRenameTarget(null)}
          onRename={applyRename}
        />
      )}
      {showArchivedSessions && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setShowArchivedSessions(false)}
        >
          <section
            className="modal archived-sessions-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="archived-sessions-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">SAVED TERMINALS</span>
                <h2 id="archived-sessions-title">Archived terminals</h2>
              </div>
              <button
                className="secondary-button"
                onClick={() => setShowArchivedSessions(false)}
              >
                Close
              </button>
            </div>
            <div className="archived-session-rows">
              {archivedSessions.map((session) => (
                <div key={session.id}>
                  <StatusDot state={session.state} compact />
                  <div>
                    <strong>{session.name}</strong>
                    <span>
                      {session.profile} · {session.backend}
                      {(session.providerSessionId ?? session.providerSessionName) &&
                        ` · ${(session.providerSessionId ?? session.providerSessionName)!.slice(0, 18)}…`}
                    </span>
                  </div>
                  <button onClick={() => run(rename(session))}>
                    <Pencil size={13} /> Rename
                  </button>
                  <button onClick={() => run(restore(session))}>
                    <RotateCcw size={13} /> Restore
                  </button>
                  <button
                    className="danger-text"
                    onClick={() => run(permanentlyDelete(session))}
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
