import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Archive,
  Clipboard,
  FileText,
  Files,
  Flag,
  History,
  MessageCircleQuestion,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  TerminalSquare,
  Trash2
} from 'lucide-react'
import type { TerminalSession } from '@shared/types'
import type {
  ProjectFileOpenRequest,
  TerminalFileTarget
} from '../lib/terminalFileLinks'
import type { ProjectWorkspaceProps } from '../projectTypeRegistry'
import {
  sessionSortOptions,
  sortSessions,
  useSessionSort
} from '../lib/sessionSort'
import { shouldOfferTmuxReconnect } from '../lib/terminalTransport'
import { tmuxOptionsCommand } from '../lib/tmuxCommands'
import { ChatHistoryPanel } from './ChatHistoryPanel'
import { ActionsPanel } from './ActionsPanel'
import { FilesPanel } from './FilesPanel'
import { HistoryPanel } from './HistoryPanel'
import { ManagedTerminal } from './ManagedTerminal'
import { NotesPanel } from './NotesPanel'
import { ProjectQnaPane } from './ProjectQnaPane'
import { RenameDialog } from './RenameDialog'
import { StatusDot } from './StatusDot'
import { TerminalLauncher } from './TerminalLauncher'
import {
  TerminalProfileIcon,
  terminalProfileLabel
} from './TerminalProfileIcon'

type WorkspaceTab =
  | 'terminal'
  | 'actions'
  | 'qna'
  | 'notes'
  | 'files'
  | 'chats'
  | 'history'

interface CachedTerminalView {
  projectId: string
  projectFolder: string
  session: TerminalSession
}

const MAX_CACHED_TERMINAL_VIEWS = 8

export function TerminalProjectWorkspace({
  project,
  connection,
  selectedSessionId,
  launchTerminalRequest,
  openSessionRequest,
  terminalTransportStates,
  onSelectSession,
  onChanged
}: ProjectWorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>('terminal')
  const [showLauncher, setShowLauncher] = useState(false)
  const [showArchivedSessions, setShowArchivedSessions] = useState(false)
  const [openFileRequest, setOpenFileRequest] =
    useState<ProjectFileOpenRequest | null>(null)
  const [sessionSort, setSessionSort] = useSessionSort()
  const [renameTarget, setRenameTarget] = useState<TerminalSession | null>(null)
  const [cachedTerminalViews, setCachedTerminalViews] = useState<
    CachedTerminalView[]
  >([])
  const [menu, setMenu] = useState<{ sessionId: string; top: number; left: number } | null>(
    null
  )
  const visibleSessions = useMemo(
    () =>
      sortSessions(
        project.sessions.filter(
          (session) => !session.archived && session.kind === 'terminal'
        ),
        sessionSort
      ),
    [project.sessions, sessionSort]
  )
  const archivedSessions = useMemo(
    () =>
      project.sessions.filter(
        (session) => session.archived && session.kind === 'terminal'
      ),
    [project.sessions]
  )
  const activeSession =
    visibleSessions.find((session) => session.id === selectedSessionId) ?? visibleSessions[0]
  const renderedTerminalViews = useMemo(() => {
    const currentSessions = new Map(
      project.sessions.map((session) => [session.id, session])
    )
    const retained = cachedTerminalViews.flatMap((view) => {
      if (view.projectId !== project.id) return [view]
      const current = currentSessions.get(view.session.id)
      return current && !current.archived
        ? [{ ...view, projectFolder: project.folder, session: current }]
        : []
    })
    if (!activeSession || retained.some((view) => view.session.id === activeSession.id)) {
      return retained
    }
    return [
      ...retained,
      {
        projectId: project.id,
        projectFolder: project.folder,
        session: activeSession
      }
    ]
  }, [activeSession, cachedTerminalViews, project.folder, project.id, project.sessions])

  useEffect(() => {
    if (!activeSession) return
    if (activeSession.id !== selectedSessionId) onSelectSession(activeSession.id)
    void window.projectConsole.terminals.acknowledge(activeSession.id).then(onChanged)
  }, [activeSession?.id])

  useEffect(() => {
    setCachedTerminalViews((current) => {
      const currentSessions = new Map(
        project.sessions.map((session) => [session.id, session])
      )
      const next = current.flatMap((view) => {
        if (view.projectId !== project.id) return [view]
        const latest = currentSessions.get(view.session.id)
        return latest && !latest.archived
          ? [{ ...view, projectFolder: project.folder, session: latest }]
          : []
      })
      if (activeSession) {
        const existingIndex = next.findIndex(
          (view) => view.session.id === activeSession.id
        )
        if (existingIndex >= 0) next.splice(existingIndex, 1)
        next.push({
          projectId: project.id,
          projectFolder: project.folder,
          session: activeSession
        })
      }
      return next.slice(-MAX_CACHED_TERMINAL_VIEWS)
    })
  }, [activeSession, project.folder, project.id, project.sessions])

  useEffect(() => {
    if (launchTerminalRequest > 0) setShowLauncher(true)
  }, [launchTerminalRequest])

  useEffect(() => {
    if (openSessionRequest > 0) setTab('terminal')
  }, [openSessionRequest])

  useEffect(() => {
    setOpenFileRequest(null)
  }, [project.id])

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
    await onChanged()
    setTab('terminal')
    onSelectSession(session.id)
  }

  function openFile(target: TerminalFileTarget) {
    setOpenFileRequest((current) => ({
      ...target,
      projectId: project.id,
      requestId: (current?.requestId ?? 0) + 1
    }))
    setTab('files')
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

  async function toggleFlag(session: TerminalSession) {
    setMenu(null)
    await window.projectConsole.terminals.setFlagged(
      session.id,
      !session.flagged
    )
    await onChanged()
  }

  async function detach(session: TerminalSession) {
    setMenu(null)
    if (
      !window.confirm(
        `Detach “${session.name}”? Its tmux session will keep running.`
      )
    )
      return
    await window.projectConsole.terminals.stop(session.id)
    await onChanged()
  }

  async function reconnect(session: TerminalSession) {
    setMenu(null)
    setTab('terminal')
    onSelectSession(session.id)
    await window.projectConsole.terminals.retryAttach(session.id, 100, 30)
    await onChanged()
  }

  async function archive(session: TerminalSession) {
    setMenu(null)
    await window.projectConsole.terminals.archive(session.id)
    await onChanged()
  }

  async function resumeAgent(session: TerminalSession) {
    setMenu(null)
    const dangerousModeConfirmed =
      !session.dangerousMode ||
      window.confirm(
        `Resume “${session.name}” with all provider permission checks disabled? ` +
          'Use this only in an isolated or disposable environment.'
      )
    if (!dangerousModeConfirmed) return
    await window.projectConsole.terminals.resumeAgent(
      session.id,
      session.dangerousMode
    )
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
        `Close and permanently delete “${session.name}” and its saved terminal output? Agent conversation archives will not be deleted.`
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
        <button className={tab === 'actions' ? 'active' : ''} onClick={() => setTab('actions')}>
          <Play size={15} />
          Actions
        </button>
        <button className={tab === 'qna' ? 'active' : ''} onClick={() => setTab('qna')}>
          <MessageCircleQuestion size={15} />
          Project Q&amp;A
        </button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
          <FileText size={15} />
          Notes
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
                    <TerminalProfileIcon
                      profile={session.profile}
                      className="terminal-profile-icon"
                    />
                    {session.pinned && <Pin className="pinned-indicator" size={10} />}
                    <span>{session.name}</span>
                    {session.dangerousMode && <small className="unsafe-badge">unsafe</small>}
                  </button>
                  {shouldOfferTmuxReconnect(
                    project,
                    session,
                    terminalTransportStates[session.id]
                  ) && (
                      <button
                        className="tab-reconnect-button"
                        aria-label={`Reconnect ${session.name} to tmux`}
                        title="Reconnect to tmux"
                        onClick={() => run(reconnect(session))}
                      >
                        <RefreshCw size={12} />
                      </button>
                    )}
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
            <div className="terminal-surface-cache">
              {renderedTerminalViews.map((view) => (
                <div
                  className={`terminal-surface ${
                    view.session.id === activeSession.id ? 'active' : ''
                  }`}
                  key={view.session.id}
                  aria-hidden={view.session.id !== activeSession.id}
                >
                  <ManagedTerminal
                    session={view.session}
                    active={view.session.id === activeSession.id}
                    projectFolder={view.projectFolder}
                    onOpenFile={openFile}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="terminal-empty">
              <div className="empty-orbit">
                <TerminalSquare size={31} />
              </div>
              <span className="eyebrow">READY WHEN YOU ARE</span>
              <h2>Start your first terminal</h2>
              <p>
                Run a shell, Codex, or Claude Code in{' '}
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
      {tab === 'actions' && (
        <ActionsPanel
          project={project}
          onChanged={onChanged}
          onOpenFile={openFile}
        />
      )}
      {tab === 'qna' && (
        <ProjectQnaPane
          project={project}
          onChanged={onChanged}
          onOpenFile={openFile}
        />
      )}
      <div
        className={`workspace-panel-cache ${tab === 'notes' ? 'active' : ''}`}
        aria-hidden={tab !== 'notes'}
      >
        <NotesPanel key={project.id} project={project} />
      </div>
      <div
        className={`workspace-panel-cache ${tab === 'files' ? 'active' : ''}`}
        aria-hidden={tab !== 'files'}
      >
        <FilesPanel
          project={project}
          openFileRequest={openFileRequest}
        />
      </div>
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
              const providerSessionReference = session.providerSessionId
              return (
                <>
                  <button onClick={() => run(rename(session))}>
                    <Pencil size={14} /> Rename
                  </button>
                  <button onClick={() => run(togglePin(session))}>
                    {session.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    {session.pinned ? 'Unpin' : 'Pin'}
                  </button>
                  <button onClick={() => run(toggleFlag(session))}>
                    <Flag
                      size={14}
                      fill={session.flagged ? 'currentColor' : 'none'}
                    />
                    {session.flagged ? 'Remove flag' : 'Flag for later'}
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
                      Copy Codex thread ID
                    </button>
                  )}
                  {session.tmuxName && (
                    <button
                      onClick={() =>
                        run(
                          window.projectConsole.system.copyText(
                            tmuxOptionsCommand(connection, session.tmuxName!)
                          )
                        )
                      }
                    >
                      <Clipboard size={14} />
                      Copy tmux options command
                    </button>
                  )}
                  {!['completed', 'error'].includes(session.state) ? (
                    <button onClick={() => run(detach(session))}>
                      <Square size={13} /> Detach
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
                    </>
                  )}
                  <button
                    className="danger-text"
                    onClick={() => run(permanentlyDelete(session))}
                  >
                    <Trash2 size={14} /> Delete
                  </button>
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
                  <TerminalProfileIcon
                    profile={session.profile}
                    className="terminal-profile-icon"
                  />
                  <div>
                    <strong>{session.name}</strong>
                    <span>
                      {terminalProfileLabel(session.profile)} · {session.backend}
                      {session.providerSessionId &&
                        ` · ${session.providerSessionId.slice(0, 18)}…`}
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
