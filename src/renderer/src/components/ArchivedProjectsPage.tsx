import { useState } from 'react'
import {
  ArchiveRestore,
  Clipboard,
  FolderArchive,
  Github,
  Laptop,
  Pencil,
  Server
} from 'lucide-react'
import type { Connection, Project } from '@shared/types'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'

interface Props {
  projects: Project[]
  connections: Connection[]
  onRestore(project: Project): Promise<void>
  onRename(project: Project): Promise<void>
}

export function ArchivedProjectsPage({
  projects,
  connections,
  onRestore,
  onRename
}: Props) {
  const [menu, setMenu] = useState<{ project: Project; x: number; y: number } | null>(
    null
  )

  function items(project: Project): ContextMenuItem[] {
    const connection = connections.find((item) => item.id === project.connectionId)
    return [
      {
        id: 'restore',
        label: 'Restore project',
        icon: <ArchiveRestore size={14} />,
        action: () => onRestore(project)
      },
      {
        id: 'rename',
        label: 'Rename',
        icon: <Pencil size={14} />,
        action: () => onRename(project)
      },
      {
        id: 'copy-path',
        label: 'Copy project path',
        icon: <Clipboard size={14} />,
        separatorBefore: true,
        action: () =>
          window.projectConsole.system.copyText(
            connection?.kind === 'ssh'
              ? `${connection.sshAlias}:${project.folder}`
              : project.folder
          )
      },
      ...(project.repositoryUrl
        ? [
            {
              id: 'repository',
              label: 'Open repository',
              icon: <Github size={14} />,
              action: () =>
                window.projectConsole.projects.openRepository(project.repositoryUrl!)
            }
          ]
        : [])
    ]
  }

  return (
    <div className="archived-projects-page">
      <header>
        <span className="eyebrow">PROJECT LIBRARY</span>
        <h1>Archived projects</h1>
        <p>Stopped projects stay here with their latest run output and activity history intact.</p>
      </header>
      {projects.length ? (
        <div className="archived-project-grid">
          {projects.map((project) => {
            const connection = connections.find((item) => item.id === project.connectionId)
            return (
              <article
                key={project.id}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ project, x: event.clientX, y: event.clientY })
                }}
              >
                <div className="archived-project-icon">
                  <FolderArchive size={20} />
                </div>
                <div className="archived-project-copy">
                  <strong>{project.name}</strong>
                  <span>
                    {connection?.kind === 'ssh' ? <Server size={12} /> : <Laptop size={12} />}
                    {connection?.name} · {project.folder}
                  </span>
                  <small>
                    {project.sessions.length} saved session
                    {project.sessions.length === 1 ? '' : 's'} · archived{' '}
                    {new Date(project.updatedAt).toLocaleDateString()}
                  </small>
                </div>
                <button
                  className="secondary-button"
                  onClick={() =>
                    void onRestore(project).catch((caught: unknown) =>
                      window.alert(caught instanceof Error ? caught.message : String(caught))
                    )
                  }
                >
                  <ArchiveRestore size={14} /> Restore
                </button>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="archive-empty">
          <FolderArchive size={36} />
          <h2>No archived projects</h2>
          <p>Projects you archive will appear here.</p>
        </div>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items(menu.project)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
