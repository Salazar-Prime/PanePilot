import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  Clipboard,
  ExternalLink,
  FileText,
  FolderOpen,
  Github,
  Laptop,
  Menu,
  MessageSquareText,
  Network,
  PanelLeftClose,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
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
  ProjectType,
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
import { TerminalProfileIcon } from './TerminalProfileIcon'

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

function isSidebarSession(session: TerminalSession): boolean {
  return session.kind === 'terminal' || session.kind === 'latex-chat'
}

export function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNewProject, setShowNewProject] = useState(false)
  const [newProjectConnectionId, setNewProjectConnectionId] = useState<string>()
  const [newProjectType, setNewProjectType] = useState<ProjectType>('terminal')
  const [showTypeMenu, setShowTypeMenu] = useState(false)
  const [showProjectSettings, setShowProjectSettings] = useState(false)
  const [showArchivedProjects, setShowArchivedProjects] = useState(false)
  const [portForwardConnection, setPortForwardConnection] = useState<Connection | null>(null)
  const [launchTerminalRequest, setLaunchTerminalRequest] = useState(0)
  const [openSessionRequest, setOpenSessionRequest] = useState(0)
  const [sidebarContext, setSidebarContext] = useState<SidebarContext | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  const [sessionSort] = useSessionSort()
  const [loading, setLoading] = useState(true)
  const [refreshingConnections, setRefreshingConnections] = useState(false)
  const [error, setError] = useState('')

  const refresh = useCallback(async () => {
    const nextProjects = await window.projectConsole.projects.list()
    setProjects(nextProjects)
  }, [])

  async function refreshSshConnections() {
    setRefreshingConnections(true)
    try {
      setConnections(await window.projectConsole.connections.refresh())
    } catch (caught) {
      showError(caught)
    } finally {
      setRefreshingConnections(false)
    }
  }

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
    const removeMetadataListener = window.projectConsole.terminals.onMetadata(() => {
      void refresh()
    })
    return () => {
      active = false
      removeStateListener()
      removeMetadataListener()
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
    if (!connection || connection.kind !== 'ssh') return
    let active = true
    const discover = async () => {
      try {
        await window.projectConsole.terminals.discover(connection.id)
        if (active) await refresh()
      } catch {
        // Remote discovery is supplemental. Offline hosts must not block the
        // locally cached project and terminal workspace.
      }
    }
    void discover()
    const timer = window.setInterval(() => void discover(), 15_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [connection?.id, connection?.kind, refresh])

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
          first.sessions.filter(
            (session) => !session.archived && isSidebarSession(session)
          ),
          sessionSort
        )[0]?.id ?? null
      )
      return
    }
    const visible = sortSessions(
      selected.sessions.filter(
        (session) => !session.archived && isSidebarSession(session)
      ),
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
        `Archive “${target.name}”? All of its ${target.type === 'latex' ? 'writing chats' : 'terminals'} must already be stopped.`
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
            next.sessions.filter(
              (session) => !session.archived && isSidebarSession(session)
            ),
            sessionSort
          )[0]?.id ?? null
        : null
    )
  }

  async function selectSession(projectId: string, sessionId: string) {
    setShowArchivedProjects(false)
    setSelectedProjectId(projectId)
    setSelectedSessionId(sessionId)
    setOpenSessionRequest((current) => current + 1)
    await window.projectConsole.terminals.acknowledge(sessionId)
    await refresh()
  }

  async function togglePin(session: TerminalSession) {
    await window.projectConsole.terminals.setPinned(session.id, !session.pinned)
    await refresh()
  }

  async function stopSession(session: TerminalSession) {
    const detachesOnly = session.kind === 'terminal'
    if (
      !window.confirm(
        detachesOnly
          ? `Detach “${session.name}”? Its tmux session will keep running.`
          : `Stop “${session.name}”? Its saved output will be kept.`
      )
    )
      return
    await window.projectConsole.terminals.stop(session.id)
    await refresh()
  }

  async function archiveSession(session: TerminalSession) {
    await window.projectConsole.terminals.archive(session.id)
    await refresh()
  }

  async function resumeAgentSession(owner: Project, session: TerminalSession) {
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
    await selectSession(owner.id, session.id)
  }

  async function deleteSession(session: TerminalSession) {
    if (
      !window.confirm(
        `Close and permanently delete “${session.name}” and its saved output? Provider chat archives will remain.`
      )
    )
      return
    await window.projectConsole.terminals.delete(session.id)
    await refresh()
  }

  function openNewProject(connectionId?: string, type: ProjectType = 'terminal') {
    setNewProjectConnectionId(connectionId)
    setNewProjectType(type)
    setShowNewProject(true)
  }

  function openProjectLauncher(target: Project) {
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
          icon:
            target.type === 'latex' ? (
              <FileText size={14} />
            ) : (
              <TerminalSquare size={14} />
            ),
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
          label: target.type === 'latex' ? 'New writing chat' : 'New terminal',
          icon:
            target.type === 'latex' ? (
              <MessageSquareText size={14} />
            ) : (
              <Plus size={14} />
            ),
          action: () => openProjectLauncher(target)
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
        ...(target.latex?.overleafUrl
          ? [
              {
                id: 'overleaf',
                label: 'Open in Overleaf',
                icon: <ExternalLink size={14} />,
                action: () =>
                  window.projectConsole.system.openExternal(
                    target.latex!.overleafUrl!
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
    const providerSessionReference = session.providerSessionId
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
      ...(providerSessionReference
        ? [
            {
              id: 'copy-provider-session',
              label: `Copy ${session.profile === 'claude' ? 'Claude session' : 'Codex thread'} ID`,
              icon: <Clipboard size={14} />,
              action: () =>
                window.projectConsole.system.copyText(providerSessionReference)
            }
          ]
        : []),
      ...(stopped
        ? [
            ...(['codex', 'claude'].includes(session.profile) && providerSessionReference
              ? [
                  {
                    id: 'resume-agent',
                    label: `Resume ${session.profile === 'claude' ? 'Claude' : 'Codex'} chat`,
                    icon: <ArchiveRestore size={14} />,
                    separatorBefore: true,
                    action: () => resumeAgentSession(owner, session)
                  }
                ]
              : []),
            {
              id: 'archive',
              label: 'Archive terminal',
              icon: <Archive size={14} />,
              separatorBefore: !(
                ['codex', 'claude'].includes(session.profile) &&
                providerSessionReference
              ),
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
              label:
                session.kind === 'terminal'
                  ? 'Detach terminal'
                  : 'Stop terminal',
              icon: <Square size={14} />,
              separatorBefore: true,
              action: () => stopSession(session)
            },
            ...(session.kind === 'terminal'
              ? [
                  {
                    id: 'delete',
                    label: 'Delete terminal',
                    icon: <Trash2 size={14} />,
                    danger: true,
                    action: () => deleteSession(session)
                  }
                ]
              : [])
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
        <div className="type-switcher-wrap">
          <button
            className="type-switcher"
            onClick={() => setShowTypeMenu((current) => !current)}
            aria-expanded={showTypeMenu}
          >
            {showArchivedProjects ? (
              <Archive size={15} />
            ) : project?.type === 'latex' ? (
              <FileText size={15} />
            ) : (
              <TerminalSquare size={15} />
            )}
            <span>{showArchivedProjects ? 'Archive' : typeDefinition.label}</span>
            <ChevronDown size={13} />
          </button>
          {showTypeMenu && (
            <div className="type-menu">
              {Object.values(projectTypeRegistry).map((definition) => {
                const first = activeProjects.find(
                  (candidate) => candidate.type === definition.id
                )
                return (
                  <button
                    key={definition.id}
                    className={project?.type === definition.id ? 'active' : ''}
                    onClick={() => {
                      setShowTypeMenu(false)
                      if (first) {
                        selectProject(first.id)
                      } else {
                        openNewProject(undefined, definition.id)
                      }
                    }}
                  >
                    {definition.id === 'latex' ? (
                      <FileText size={15} />
                    ) : (
                      <TerminalSquare size={15} />
                    )}
                    <span>
                      <strong>{definition.label}</strong>
                      <small>
                        {first
                          ? `${activeProjects.filter((candidate) => candidate.type === definition.id).length} projects`
                          : 'Create the first project'}
                      </small>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
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
          {project?.latex?.overleafUrl && (
            <button
              className="secondary-button header-button overleaf-button"
              onClick={() =>
                void window.projectConsole.system.openExternal(
                  project.latex!.overleafUrl!
                )
              }
            >
              <ExternalLink size={15} /> Overleaf
            </button>
          )}
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
                    candidate.sessions.filter(
                      (session) =>
                        !session.archived && isSidebarSession(session)
                    ),
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
                          <span className={`project-glyph ${candidate.type}`}>
                            {candidate.type === 'latex' ? (
                              <FileText size={12} />
                            ) : (
                              candidate.name.slice(0, 1).toUpperCase()
                            )}
                          </span>
                          <span className="row-label">{candidate.name}</span>
                          {candidate.type === 'latex' && visibleSessions.length > 0 && (
                            <small className="project-chat-count">
                              {visibleSessions.length}
                            </small>
                          )}
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
                                <TerminalProfileIcon
                                  profile={session.profile}
                                  className="terminal-profile-icon"
                                />
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
            className="refresh-connections-sidebar"
            onClick={() => void refreshSshConnections()}
            disabled={refreshingConnections}
            title="Re-read SSH hosts from ~/.ssh/config"
          >
            <RefreshCw
              size={15}
              className={refreshingConnections ? 'spin' : ''}
            />
            <span>
              {refreshingConnections ? 'Refreshing SSH hosts…' : 'Refresh SSH hosts'}
            </span>
          </button>
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
            openSessionRequest={openSessionRequest}
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
          initialProjectType={newProjectType}
          onClose={() => {
            setShowNewProject(false)
            setNewProjectConnectionId(undefined)
            setNewProjectType('terminal')
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
          onChanged={refresh}
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
