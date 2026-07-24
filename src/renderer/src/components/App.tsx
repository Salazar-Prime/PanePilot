import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bot,
  Boxes,
  ChevronDown,
  ChevronRight,
  Github,
  Laptop,
  Menu,
  PanelLeftClose,
  Plus,
  Server,
  Settings,
  Sparkles,
  TerminalSquare
} from 'lucide-react'
import type { Connection, CreateProjectInput, Project } from '@shared/types'
import { isAttentionState } from '../lib/status'
import { projectTypeRegistry } from '../projectTypeRegistry'
import { NewProjectDialog } from './NewProjectDialog'
import { StatusDot } from './StatusDot'

export function App() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showNewProject, setShowNewProject] = useState(false)
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
        setSelectedProjectId((current) => current ?? nextProjects[0]?.id ?? null)
      })
      .catch((caught) => setError(caught instanceof Error ? caught.message : String(caught)))
      .finally(() => setLoading(false))
    const removeStateListener = window.projectConsole.terminals.onState(() => {
      void refresh()
    })
    return () => {
      active = false
      removeStateListener()
    }
  }, [refresh])

  const project = projects.find((item) => item.id === selectedProjectId) ?? null
  const connection = connections.find((item) => item.id === project?.connectionId)

  useEffect(() => {
    if (!projects.length) {
      setSelectedProjectId(null)
      setSelectedSessionId(null)
      return
    }
    const selected = projects.find((item) => item.id === selectedProjectId)
    if (!selected) {
      setSelectedProjectId(projects[0].id)
      setSelectedSessionId(projects[0].sessions.find((session) => !session.archived)?.id ?? null)
      return
    }
    const visible = selected.sessions.filter((session) => !session.archived)
    if (!visible.some((session) => session.id === selectedSessionId)) {
      setSelectedSessionId(visible[0]?.id ?? null)
    }
  }, [projects, selectedProjectId, selectedSessionId])

  async function createProject(input: CreateProjectInput) {
    const created = await window.projectConsole.projects.create(input)
    await refresh()
    setSelectedProjectId(created.id)
    setSelectedSessionId(null)
  }

  function selectProject(id: string) {
    const next = projects.find((item) => item.id === id)
    setSelectedProjectId(id)
    setSelectedSessionId(next?.sessions.find((session) => !session.archived)?.id ?? null)
  }

  async function selectSession(projectId: string, sessionId: string) {
    setSelectedProjectId(projectId)
    setSelectedSessionId(sessionId)
    await window.projectConsole.terminals.acknowledge(sessionId)
    await refresh()
  }

  const workingCount = useMemo(
    () =>
      projects.flatMap((item) => item.sessions).filter((session) => !session.archived && session.state === 'running')
        .length,
    [projects]
  )
  const attentionCount = useMemo(
    () =>
      projects
        .flatMap((item) => item.sessions)
        .filter((session) => !session.archived && isAttentionState(session.state)).length,
    [projects]
  )
  const typeDefinition = project ? projectTypeRegistry[project.type] : projectTypeRegistry.terminal
  const Workspace = typeDefinition.Workspace

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
          <TerminalSquare size={15} />
          <span>{typeDefinition.label}</span>
          <ChevronDown size={13} />
        </div>
        <div className="top-divider" />
        <div className="project-identity">
          {project ? (
            <>
              <strong>{project.name}</strong>
              <span>{connection?.kind === 'ssh' ? `${connection.name}:${project.folder}` : project.folder}</span>
            </>
          ) : (
            <strong>PanePilot</strong>
          )}
        </div>
        <div className="top-actions">
          {project?.repositoryUrl && (
            <button
              className="secondary-button header-button"
              onClick={() => void window.projectConsole.projects.openRepository(project.repositoryUrl!)}
            >
              <Github size={15} /> Repository
            </button>
          )}
          <button className="icon-button" aria-label="Settings" title="Settings">
            <Settings size={16} />
          </button>
          <button className="primary-button header-button" onClick={() => setShowNewProject(true)}>
            <Plus size={15} /> Project
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
            const connectionProjects = projects.filter(
              (candidate) => candidate.connectionId === item.id
            )
            if (!connectionProjects.length && item.kind === 'ssh') return null
            return (
              <section className="connection-group" key={item.id}>
                <div className="connection-heading">
                  {item.kind === 'local' ? <Laptop size={14} /> : <Server size={14} />}
                  <span>{item.name}</span>
                  <small>{connectionProjects.length}</small>
                </div>
                {connectionProjects.map((candidate) => {
                  const visibleSessions = candidate.sessions.filter((session) => !session.archived)
                  return (
                    <div className="project-tree" key={candidate.id}>
                      <button
                        className={`project-row ${candidate.id === selectedProjectId ? 'selected' : ''}`}
                        onClick={() => selectProject(candidate.id)}
                      >
                        <ChevronRight size={13} />
                        <span className="project-glyph">{candidate.name.slice(0, 1).toUpperCase()}</span>
                        <span className="row-label">{candidate.name}</span>
                        <StatusDot state={candidate.state} compact />
                      </button>
                      {visibleSessions.length > 0 && (
                        <div className="session-tree">
                          {visibleSessions.map((session) => (
                            <button
                              key={session.id}
                              className={`session-row ${
                                candidate.id === selectedProjectId &&
                                session.id === selectedSessionId
                                  ? 'selected'
                                  : ''
                              }`}
                              onClick={() => void selectSession(candidate.id, session.id)}
                            >
                              <StatusDot state={session.state} compact />
                              <span>{session.name}</span>
                              {isAttentionState(session.state) && <small className="attention-badge">!</small>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {item.kind === 'local' && connectionProjects.length === 0 && (
                  <button className="sidebar-add" onClick={() => setShowNewProject(true)}>
                    <Plus size={14} /> Add your first project
                  </button>
                )}
              </section>
            )
          })}
        </div>
        <button className="new-project-sidebar" onClick={() => setShowNewProject(true)}>
          <Plus size={15} />
          <span>New project</span>
        </button>
      </aside>

      <main className="main-content">
        {error ? (
          <div className="capability-empty error-empty">
            <Boxes size={35} />
            <h2>PanePilot couldn’t open</h2>
            <p>{error}</p>
          </div>
        ) : project ? (
          <Workspace
            project={project}
            connection={connection}
            selectedSessionId={selectedSessionId}
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
              Bring local and SSH projects into one place, run agents in persistent terminals,
              and see exactly when they need you.
            </p>
            <button className="primary-button welcome-button" onClick={() => setShowNewProject(true)}>
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
          <span className="project-total">{projects.length} projects</span>
        </div>
      </footer>

      {showNewProject && (
        <NewProjectDialog
          connections={connections}
          onClose={() => setShowNewProject(false)}
          onCreate={createProject}
        />
      )}
    </div>
  )
}
