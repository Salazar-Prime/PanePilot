import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  Clipboard,
  FolderOpen,
  Github,
  Laptop,
  Menu,
  Network,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Server,
  Settings,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  Wifi
} from 'lucide-react'
import type {
  Connection,
  CreateProjectInput,
  Project,
  TerminalSession
} from '@shared/types'
import { isAttentionState } from '../lib/status'
import { sortSessions, useSessionSort } from '../lib/sessionSort'
import { projectTypeRegistry } from '../projectTypeRegistry'
import { ArchivedProjectsPage } from './ArchivedProjectsPage'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { NewProjectDialog } from './NewProjectDialog'
import { PortForwardDialog } from './PortForwardDialog'
import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { RenameDialog } from './RenameDialog'
import { StatusDot } from './StatusDot'

type SidebarContext =
  | { kind: 'connection'; connection: Connection; x: number; y: number }
  | { kind: 'project'; project: Project; x: number; y: number }
  | {
      kind: 'session'
      project: Project
      session: TerminalSession
      x: number
      y: number
    }

type RenameTarget =
  | { kind: 'project'; project: Project }
  | { kind: 'session'; session: TerminalSession }

export function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectConnectionId, setNewProjectConnectionId] = useState<string>()
  const [showProjectSettings, setShowProjectSettings] = useState(false)
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
  const [portForwardConnection, setPortForwardConnection] = useState<Connection | null>(null)
  const [launchTerminalRequest, setLaunchTerminalRequest] = useState(0)
  const [sidebarContext, setSidebarContext] = useState<SidebarContext | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [sessionSort] = useSessionSort()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const nextProjects = await window.projectConsole.projects.list()
    setProjects(nextProjects)
  }, [])

  useEffect(() => {
    let active = true
    void Promise.all([
      window.projectConsole.connections.list(),
      window.projectConsole.projects.list()
    ])
      .then(([nextConnections, nextProjects]) => {
        if (!active) return
        setConnections(nextConnections)
        setProjects(nextProjects)
        const firstActive = nextProjects.find((project) => !project.archived)
        setSelectedProjectId((current) => current ?? firstActive?.id ?? null)
      })
      .catch((caught) => setError(messageFor(caught)))
      .finally(() => setLoading(false))
    const removeStateListener = window.projectConsole.terminals.onState(() => {
      void refresh()
    })
    return () => {
      active = false
      removeStateListener()
    }
  }, [refresh])

  const activeProjects = useMemo(
    () => projects.filter((project) => !project.archived),
    [projects]
  )
  const archivedProjects = useMemo(
    () => projects.filter((project) => project.archived),
    [projects]
  )
  const project =
    !showArchivedProjects
      ? activeProjects.find((item) => item.id === selectedProjectId) ?? null
      : null
  const connection = connections.find((item) => item.id === project?.connectionId)

  useEffect(() => {
    if (showArchivedProjects) return
    if (!activeProjects.length) {
      setSelectedProjectId(null)
      setSelectedSessionId(null)
      return
    }
    const selected = activeProjects.find((item) => item.id === selectedProjectId)
    if (!selected) {
      const first = activeProjects[0]
      setSelectedProjectId(first.id)
      setSelectedSessionId(
        sortSessions(
          first.sessions.filter((session) => !session.archived),
          sessionSort
        )[0]?.id ?? null
      )
      return
    }
    const visible = sortSessions(
      selected.sessions.filter((session) => !session.archived),
      sessionSort
    )
    if (!visible.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(visible[0]?.id ?? null)
    }
  }, [
    activeProjects,
    selectedProjectId,
    selectedSessionId,
    sessionSort,
    showArchivedProjects
  ])

  async function createProject(input: CreateProjectInput) {
    const created = await window.projectConsole.projects.create(input)
    await refresh()
    setShowArchivedProjects(false)
    setSelectedProjectId(created.id)
    setSelectedSessionId(null)
  }

  async function renameCurrentProject(name: string) {
    if (!project) return
    await window.projectConsole.projects.rename(project.id, name)
    await refresh()
  }

  async function promptRenameProject(target: Project) {
    setSidebarContext(null)
    setRenameTarget({ kind: 'project', project: target })
  }

  async function promptRenameSession(session: TerminalSession) {
    setSidebarContext(null)
    setRenameTarget({ kind: 'session', session })
  }

  async function applyRename(name: string) {
    if (!renameTarget) return
    if (renameTarget.kind === 'project') {
      await window.projectConsole.projects.rename(renameTarget.project.id, name)
    } else {
      await window.projectConsole.terminals.rename(renameTarget.session.id, name)
    }
    await refresh()
  }

  async function archiveProject(target: Project) {
    if (
      !window.confirm(
        `Archive “${target.name}”? All of its terminals must already be stopped.`
      )
    )
      return
    await window.projectConsole.projects.archive(target.id)
    const nextProject = activeProjects.find((candidate) => candidate.id !== target.id)
    setSelectedProjectId(nextProject?.id ?? null)
    setSelectedSessionId(null)
    await refresh()
  }

  async function restoreProject(target: Project) {
    await window.projectConsole.projects.restore(target.id)
    await refresh()
    setShowArchivedProjects(false)
    setSelectedProjectId(target.id)
    setSelectedSessionId(null)
  }

  function selectProject(id: string) {
    const next = activeProjects.find((item) => item.id === id)
    setShowArchivedProjects(false)
    setSelectedProjectId(id)
    setSelectedSessionId(
      next
        ? sortSessions(
            next.sessions.filter((session) => !session.archived),
            sessionSort
          )[0]?.id ?? null
        : null
    )
  }

  async function selectSession(projectId: string, sessionId: string) {
    setShowArchivedProjects(false)
    setSelectedProjectId(projectId)
    setSelectedSessionId(sessionId)
    await window.projectConsole.terminals.acknowledge(sessionId)
    await refresh()
  }

  async function togglePin(session: TerminalSession) {
    await window.projectConsole.terminals.setPinned(session.id, !session.pinned)
    await refresh()
  }

  async function stopSession(session: TerminalSession) {
    if (!window.confirm(`Stop “${session.name}”? Its saved output will be kept.`)) return
    await window.projectConsole.terminals.stop(session.id)
    await refresh()
  }

  async function archiveSession(session: TerminalSession) {
    await window.projectConsole.terminals.archive(session.id)
    await refresh()
  }

  async function deleteSession(session: TerminalSession) {
    if (
      !window.confirm(
        `Permanently delete “${session.name}” and its saved output? Provider chat archives will remain.`
      )
    )
      return
    await window.projectConsole.terminals.delete(session.id)
    await refresh()
  }

  function openNewProject(connectionId?: string) {
    setNewProjectConnectionId(connectionId)
    setShowNewProject(true)
  }

  function openNewTerminal(target: Project) {
    selectProject(target.id)
    setLaunchTerminalRequest((current) => current + 1)
  }

  const workingCount = useMemo(
    () =>
      activeProjects
        .flatMap((item) => item.sessions)
        .filter(
          (session) => !session.archived && session.state === 'running'
        ).length,
    [activeProjects]
  )
  const attentionCount = useMemo(
    () =>
      activeProjects
        .flatMap((item) => item.sessions)
        .filter(
          (session) =>
            !session.archived && isAttentionState(session.state)
        ).length,
    [activeProjects]
  )
  const typeDefinition = project
    ? projectTypeRegistry[project.type]
    : projectTypeRegistry.terminal
  const Workspace = typeDefinition.Workspace

  function contextItems(context: SidebarContext): ContextMenuItem[] {
    if (context.kind === 'connection') {
      const { connection: target } = context
      return [
        {
          id: 'new-project',
          label: 'New project on this device',
          icon: <Plus size={14} />,
          action: () => openNewProject(target.id)
        },
        ...(target.kind === 'ssh'
          ? [
              {
                id: 'test',
                label: 'Test SSH connection',
                icon: <Wifi size={14} />,
                action: async () => {
                  const result =
                    await window.projectConsole.connections.test(target.id)
                  window.alert(
                    `${result.message}\n${result.ok ? `${result.latencyMs} ms` : 'Connection failed'}`
                  )
                }
              },
              {
                id: 'forwards',
                label: 'Manage port forwards',
                icon: <Network size={14} />,
                action: () => setPortForwardConnection(target)
              },
              {
                id: 'copy-ssh',
                label: 'Copy SSH command',
                icon: <Clipboard size={14} />,
                separatorBefore: true,
                action: () =>
                  window.projectConsole.system.copyText(
                    `ssh ${target.sshAlias}`
                  )
              }
            ]
          : [])
      ]
    }

    if (context.kind === 'project') {
      const target = context.project
      const targetConnection = connections.find(
        (item) => item.id === target.connectionId
      )
      return [
        {
          id: 'open',
          label: 'Open project',
          icon: <TerminalSquare size={14} />,
          action: () => selectProject(target.id)
        },
        {
          id: 'rename',
          label: 'Rename',
          icon: <Pencil size={14} />,
          action: () => promptRenameProject(target)
        },
        {
          id: 'new-terminal',
          label: 'New terminal',
          icon: <Plus size={14} />,
          action: () => openNewTerminal(target)
        },
        ...(targetConnection?.kind === 'local'
          ? [
              {
                id: 'folder',
                label: 'Open in Finder',
                icon: <FolderOpen size={14} />,
                separatorBefore: true,
                action: () =>
                  window.projectConsole.system.openProjectFolder(target.id)
              }
            ]
          : []),
        ...(target.repositoryUrl
          ? [
              {
                id: 'repository',
                label: 'Open repository',
                icon: <Github size={14} />,
                action: () =>
                  window.projectConsole.projects.openRepository(
                    target.repositoryUrl!
                  )
              }
            ]
          : []),
        {
          id: 'copy-path',
          label: 'Copy project path',
          icon: <Clipboard size={14} />,
          action: () =>
            window.projectConsole.system.copyText(
              targetConnection?.kind === 'ssh'
                ? `${targetConnection.sshAlias}:${target.folder}`
                : target.folder
            )
        },
        {
          id: 'archive',
          label: 'Archive project',
          icon: <Archive size={14} />,
          separatorBefore: true,
          action: () => archiveProject(target)
        }
      ]
    }

    const { project: owner, session } = context
    const ownerConnection = connections.find(
      (item) => item.id === owner.connectionId
    )
    const stopped = ['completed', 'error'].includes(session.state)
    return [
      {
        id: 'open',
        label: 'Open terminal',
        icon: <TerminalSquare size={14} />,
        action: () => selectSession(owner.id, session.id)
      },
      {
        id: 'rename',
        label: 'Rename terminal and tmux',
        icon: <Pencil size={14} />,
        action: () => promptRenameSession(session)
      },
      {
        id: 'pin',
        label: session.pinned ? 'Unpin terminal' : 'Pin terminal',
        icon: session.pinned ? <PinOff size={14} /> : <Pin size={14} />,
        action: () => togglePin(session)
      },
      ...(session.tmuxName
        ? [
            {
              id: 'copy-attach',
              label: 'Copy tmux attach command',
              icon: <Clipboard size={14} />,
              separatorBefore: true,
              action: () =>
                window.projectConsole.system.copyText(
                  ownerConnection?.kind === 'ssh'
                    ? `ssh -t ${ownerConnection.sshAlias} tmux attach-session -t ${shellQuote(`=${session.tmuxName}`)}`
                    : `tmux attach-session -t ${shellQuote(`=${session.tmuxName}`)}`
                )
            }
          ]
        : []),
      ...(stopped
        ? [
            {
              id: 'archive',
              label: 'Archive terminal',
              icon: <Archive size={14} />,
              action: () => archiveSession(session)
            },
            {
              id: 'delete',
              label: 'Delete terminal',
              icon: <Trash2 size={14} />,
              danger: true,
              action: () => deleteSession(session)
            }
          ]
        : [
            {
              id: 'stop',
              label: 'Stop terminal',
              icon: <Square size={14} />,
              danger: true,
              separatorBefore: true,
              action: () => stopSession(session)
            }
          ])
    ]
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="brand-mark">
          <TerminalSquare size={23} />
        </div>
        <span>Opening PanePilot…</span>
      </div>
    )
  }

  return (
    <div className={`app-shell ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
      <header className="top-bar">
        <div className="traffic-spacer" />
        <button
          className="icon-button sidebar-toggle"
          onClick={() => setSidebarOpen((value) => !value)}
          aria-label="Toggle sidebar"
        >
          {sidebarOpen ? <PanelLeftClose size={17} /> : <Menu size={17} />}
        </button>
        <div className="type-switcher">
          {showArchivedProjects ? <Archive size={15} /> : <TerminalSquare size={15} />}
          <span>{showArchivedProjects ? 'Archive' : typeDefinition.label}</span>
          <ChevronDown size={13} />
        </div>
        <div className="top-divider" />
        <div className="project-identity">
          {showArchivedProjects ? (
            <strong>Archived projects</strong>
          ) : project ? (
            <>
              <strong>{project.name}</strong>
              <span>
                {connection?.kind === 'ssh'
                  ? `${connection.name}:${project.folder}`
                  : project.folder}
              </span>
            </>
          ) : (
            <strong>PanePilot</strong>
          )}
        </div>
        <div className="top-actions">
          {project?.repositoryUrl && (
            <button
              className="secondary-button header-button"
              onClick={() =>
                void window.projectConsole.projects.openRepository(
                  project.repositoryUrl!
                )
              }
            >
              <Github size={15} /> Repository
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Project settings"
            title="Project settings"
            disabled={!project}
            onClick={() => setShowProjectSettings(true)}
          >
            <Settings size={16} />
          </button>
        </div>
      </header>

      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">
            <TerminalSquare size={19} />
          </div>
          <div>
            <strong>PanePilot</strong>
            <span>Agent workspace</span>
          </div>
        </div>
        <div className="sidebar-scroll">
          {connections.map((item) => {
            const connectionProjects = activeProjects.filter(
              (candidate) => candidate.connectionId === item.id
            )
            if (item.kind === 'ssh' && connectionProjects.length === 0) return null
            return (
              <section className="connection-group" key={item.id}>
                <div
                  className="connection-heading"
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setSidebarContext({
                      kind: 'connection',
                      connection: item,
                      x: event.clientX,
                      y: event.clientY
                    })
                  }}
                >
                  {item.kind === 'local' ? (
                    <Laptop size={14} />
                  ) : (
                    <Server size={14} />
                  )}
                  <span>{item.name}</span>
                  <small>{connectionProjects.length}</small>
                </div>
                {connectionProjects.map((candidate) => {
                  const visibleSessions = sortSessions(
                    candidate.sessions.filter((session) => !session.archived),
                    sessionSort
                  )
                  return (
                    <div className="project-tree" key={candidate.id}>
                      <div
                        className={`project-row ${
                          candidate.id === selectedProjectId &&
                          !showArchivedProjects
                            ? 'selected'
                            : ''
                        }`}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setSidebarContext({
                            kind: 'project',
                            project: candidate,
                            x: event.clientX,
                            y: event.clientY
                          })
                        }}
                      >
                        <button
                          className="sidebar-row-main"
                          onClick={() => selectProject(candidate.id)}
                        >
                          <ChevronRight size={13} />
                          <span className="project-glyph">
                            {candidate.name.slice(0, 1).toUpperCase()}
                          </span>
                          <span className="row-label">{candidate.name}</span>
                          <StatusDot state={candidate.state} compact />
                        </button>
                        <button
                          className="sidebar-hover-action"
                          title="Rename project"
                          onClick={() =>
                            void promptRenameProject(candidate).catch(showError)
                          }
                        >
                          <Pencil size={12} />
                        </button>
                      </div>
                      {visibleSessions.length > 0 && (
                        <div className="session-tree">
                          {visibleSessions.map((session) => (
                            <div
                              key={session.id}
                              className={`session-row ${
                                candidate.id === selectedProjectId &&
                                session.id === selectedSessionId &&
                                !showArchivedProjects
                                  ? 'selected'
                                  : ''
                              }`}
                              onContextMenu={(event) => {
                                event.preventDefault()
                                setSidebarContext({
                                  kind: 'session',
                                  project: candidate,
                                  session,
                                  x: event.clientX,
                                  y: event.clientY
                                })
                              }}
                            >
                              <button
                                className="sidebar-row-main"
                                onClick={() =>
                                  void selectSession(candidate.id, session.id)
                                }
                              >
                                <StatusDot state={session.state} compact />
                                {session.pinned && (
                                  <Pin className="pinned-indicator" size={10} />
                                )}
                                <span>{session.name}</span>
                                {isAttentionState(session.state) && (
                                  <small className="attention-badge">!</small>
                                )}
                              </button>
                              <button
                                className="sidebar-hover-action"
                                title="Rename terminal and tmux session"
                                onClick={() =>
                                  void promptRenameSession(session).catch(showError)
                                }
                              >
                                <Pencil size={11} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {item.kind === 'local' && connectionProjects.length === 0 && (
                  <button
                    className="sidebar-add"
                    onClick={() => openNewProject(item.id)}
                  >
                    <Plus size={14} /> Add your first project
                  </button>
                )}
              </section>
            )
          })}
        </div>
        <div className="sidebar-footer-actions">
          <button
            className={`archived-projects-sidebar ${
              showArchivedProjects ? 'selected' : ''
            }`}
            onClick={() => {
              setShowArchivedProjects(true)
              setShowProjectSettings(false)
            }}
          >
            <Archive size={15} />
            <span>Archived projects</span>
            <small>{archivedProjects.length}</small>
          </button>
          <button className="new-project-sidebar" onClick={() => openNewProject()}>
            <Plus size={15} />
            <span>New project</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        {error ? (
          <div className="capability-empty error-empty">
            <Boxes size={35} />
            <h2>PanePilot couldn’t open</h2>
            <p>{error}</p>
          </div>
        ) : showArchivedProjects ? (
          <ArchivedProjectsPage
            projects={archivedProjects}
            connections={connections}
            onRestore={restoreProject}
            onRename={promptRenameProject}
          />
        ) : project ? (
          <Workspace
            project={project}
            connection={connection}
            selectedSessionId={selectedSessionId}
            launchTerminalRequest={launchTerminalRequest}
            onSelectSession={setSelectedSessionId}
            onChanged={refresh}
          />
        ) : (
          <div className="welcome">
            <div className="welcome-art">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="welcome-mark">
                <Bot size={35} />
              </div>
              <Sparkles className="spark spark-one" size={18} />
              <Sparkles className="spark spark-two" size={13} />
            </div>
            <span className="eyebrow">YOUR PROJECT CONTROL CENTER</span>
            <h1>Keep every agent in view.</h1>
            <p>
              Bring local and SSH projects into one place, run agents in persistent
              terminals, and see exactly when they need you.
            </p>
            <button
              className="primary-button welcome-button"
              onClick={() => openNewProject()}
            >
              <Plus size={16} /> Add a project
            </button>
          </div>
        )}
      </main>

      <footer className="status-bar">
        <div className="status-brand">
          <span className="live-pip" />
          Ready
        </div>
        <div className="status-summary">
          <span>
            <span className="mini-dot running" />
            {workingCount} working
          </span>
          <span>
            <span className="mini-dot attention" />
            {attentionCount} need{attentionCount === 1 ? 's' : ''} attention
          </span>
          <span className="project-total">{activeProjects.length} projects</span>
        </div>
      </footer>

      {showNewProject && (
        <NewProjectDialog
          connections={connections}
          initialConnectionId={newProjectConnectionId}
          onClose={() => {
            setShowNewProject(false)
            setNewProjectConnectionId(undefined)
          }}
          onCreate={createProject}
        />
      )}
      {showProjectSettings && project && (
        <ProjectSettingsDialog
          project={project}
          connection={connection}
          onClose={() => setShowProjectSettings(false)}
          onRename={renameCurrentProject}
        />
      )}
      {renameTarget && (
        <RenameDialog
          title={
            renameTarget.kind === 'project'
              ? `Rename ${renameTarget.project.name}`
              : `Rename ${renameTarget.session.name}`
          }
          eyebrow={
            renameTarget.kind === 'project' ? 'PROJECT NAME' : 'TERMINAL NAME'
          }
          label={
            renameTarget.kind === 'project'
              ? 'Project name'
              : 'Terminal and tmux session name'
          }
          initialValue={
            renameTarget.kind === 'project'
              ? renameTarget.project.name
              : renameTarget.session.name
          }
          description={
            renameTarget.kind === 'session'
              ? 'PanePilot will rename the terminal and its tmux session together.'
              : undefined
          }
          maxLength={renameTarget.kind === 'session' ? 80 : undefined}
          onClose={() => setRenameTarget(null)}
          onRename={applyRename}
        />
      )}
      {portForwardConnection && (
        <PortForwardDialog
          connection={portForwardConnection}
          onClose={() => setPortForwardConnection(null)}
        />
      )}
      {sidebarContext && (
        <ContextMenu
          x={sidebarContext.x}
          y={sidebarContext.y}
          items={contextItems(sidebarContext)}
          onClose={() => setSidebarContext(null)}
        />
      )}
    </div>
  )
}

function messageFor(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function showError(value: unknown): void {
  window.alert(messageFor(value))
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
