import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Connection, Project, TerminalSession } from '@shared/types'
import type {
  ProjectWorkspaceProps
} from '../projectTypeRegistry'
import { projectTypeRegistry } from '../projectTypeRegistry'
import {
  MAX_WARM_TERMINALS_PER_PANE,
  reconcileTerminalSurfaces,
  retainTerminalSurface,
  type TerminalSurfaceCacheController,
  type TerminalSurfaceCacheEntry
} from '../lib/terminalSurfaceCache'
import { TerminalProjectWorkspace } from './TerminalProjectWorkspace'

interface PaneWorkspaceStackProps
  extends Omit<
    ProjectWorkspaceProps,
    | 'project'
    | 'connection'
    | 'workspaceActive'
    | 'terminalSurfaceCache'
    | 'onTransferSession'
    | 'onChanged'
  > {
  activeProject: Project
  projects: Project[]
  connections: Connection[]
  onTransferSession?(project: Project, session: TerminalSession): void
  onChanged(projectId: string): Promise<void>
}

export function PaneWorkspaceStack({
  activeProject,
  projects,
  connections,
  selectedSessionId,
  launchTerminalRequest,
  openSessionRequest,
  terminalTransportStates,
  openSessionIds,
  onOpenSession,
  onCloseSession,
  onSessionSelected,
  onLaunchTerminalRequestHandled,
  onOpenSessionRequestHandled,
  onSwapPanes,
  onTransferSession,
  onSelectSession,
  onChanged
}: PaneWorkspaceStackProps) {
  const [terminalViews, setTerminalViews] = useState<TerminalSurfaceCacheEntry[]>(
    []
  )

  const retainTerminal = useCallback((view: TerminalSurfaceCacheEntry) => {
    setTerminalViews((current) =>
      retainTerminalSurface(current, view, MAX_WARM_TERMINALS_PER_PANE)
    )
  }, [])

  useEffect(() => {
    setTerminalViews((current) => reconcileTerminalSurfaces(current, projects))
  }, [projects])

  const terminalSurfaceCache = useMemo<TerminalSurfaceCacheController>(
    () => ({ views: terminalViews, retain: retainTerminal }),
    [retainTerminal, terminalViews]
  )
  const terminalProjects = useMemo(() => {
    const ids = new Set(terminalViews.map((view) => view.projectId))
    if (activeProject.type === 'terminal') ids.add(activeProject.id)
    return [...ids].flatMap((projectId): Project[] => {
      const project = projects.find(
        (candidate) => candidate.id === projectId && candidate.type === 'terminal'
      )
      return project ? [project] : []
    })
  }, [activeProject.id, activeProject.type, projects, terminalViews])
  const NonTerminalWorkspace =
    activeProject.type === 'terminal'
      ? null
      : projectTypeRegistry[activeProject.type].Workspace

  return (
    <div className="pane-workspace-stack">
      {terminalProjects.map((project) => {
        const active =
          activeProject.type === 'terminal' && activeProject.id === project.id
        return (
          <div
            className={`pane-workspace-entry ${active ? 'active' : ''}`}
            key={project.id}
            aria-hidden={!active}
          >
            <TerminalProjectWorkspace
              project={project}
              connection={connections.find(
                (connection) => connection.id === project.connectionId
              )}
              workspaceActive={active}
              terminalSurfaceCache={terminalSurfaceCache}
              selectedSessionId={active ? selectedSessionId : null}
              launchTerminalRequest={active ? launchTerminalRequest : null}
              openSessionRequest={active ? openSessionRequest : null}
              terminalTransportStates={terminalTransportStates}
              openSessionIds={openSessionIds}
              onOpenSession={onOpenSession}
              onCloseSession={onCloseSession}
              onSessionSelected={onSessionSelected}
              onLaunchTerminalRequestHandled={onLaunchTerminalRequestHandled}
              onOpenSessionRequestHandled={onOpenSessionRequestHandled}
              onSwapPanes={onSwapPanes}
              onTransferSession={
                onTransferSession
                  ? (session) => onTransferSession(project, session)
                  : undefined
              }
              onSelectSession={onSelectSession}
              onChanged={() => onChanged(project.id)}
            />
          </div>
        )
      })}

      {NonTerminalWorkspace && (
        <div className="pane-workspace-entry active">
          <NonTerminalWorkspace
            project={activeProject}
            connection={connections.find(
              (connection) => connection.id === activeProject.connectionId
            )}
            workspaceActive
            terminalSurfaceCache={terminalSurfaceCache}
            selectedSessionId={selectedSessionId}
            launchTerminalRequest={launchTerminalRequest}
            openSessionRequest={openSessionRequest}
            terminalTransportStates={terminalTransportStates}
            openSessionIds={openSessionIds}
            onOpenSession={onOpenSession}
            onCloseSession={onCloseSession}
            onSessionSelected={onSessionSelected}
            onLaunchTerminalRequestHandled={onLaunchTerminalRequestHandled}
            onOpenSessionRequestHandled={onOpenSessionRequestHandled}
            onSwapPanes={onSwapPanes}
            onTransferSession={
              onTransferSession
                ? (session) => onTransferSession(activeProject, session)
                : undefined
            }
            onSelectSession={onSelectSession}
            onChanged={() => onChanged(activeProject.id)}
          />
        </div>
      )}
    </div>
  )
}
