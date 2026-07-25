import { useEffect, useState } from 'react'
import {
  ChevronUp,
  FileText,
  Folder,
  FolderOpen,
  Github,
  Laptop,
  Link2,
  LoaderCircle,
  Server,
  TerminalSquare,
  X
} from 'lucide-react'
import type {
  Connection,
  CreateProjectInput,
  ProjectType,
  RemoteFolderListing
} from '@shared/types'
import { projectTypeRegistry } from '../projectTypeRegistry'

interface Props {
  connections: Connection[]
  initialConnectionId?: string
  initialProjectType?: ProjectType
  onClose(): void
  onCreate(input: CreateProjectInput): Promise<void>
}

export function NewProjectDialog({
  connections,
  initialConnectionId,
  initialProjectType = 'terminal',
  onClose,
  onCreate
}: Props) {
  const [type, setType] = useState<ProjectType>(initialProjectType)
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [connectionId, setConnectionId] = useState(
    initialConnectionId ?? connections[0]?.id ?? 'local'
  )
  const [folder, setFolder] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [mainFile, setMainFile] = useState('main.tex')
  const [contextFolder, setContextFolder] = useState('context')
  const [overleafUrl, setOverleafUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [remoteListing, setRemoteListing] = useState<RemoteFolderListing | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const connection = connections.find((item) => item.id === connectionId)
  const definition = projectTypeRegistry[type]

  useEffect(() => {
    if (!nameEdited && folder) {
      const parts = folder.replace(/\/+$/, '').split('/')
      setName(parts.at(-1) ?? '')
    }
  }, [folder, nameEdited])

  useEffect(() => {
    if (connection?.kind !== 'ssh') {
      setRemoteListing(null)
      return
    }
    void browseRemote()
  }, [connectionId])

  async function chooseFolder() {
    const selected = await window.projectConsole.projects.chooseFolder()
    if (selected) setFolder(selected)
  }

  async function browseRemote(path?: string) {
    setRemoteLoading(true)
    setError('')
    try {
      const listing = await window.projectConsole.remoteFolders.list(connectionId, path)
      setRemoteListing(listing)
      setFolder(listing.currentPath)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setRemoteLoading(false)
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const base = {
        name,
        connectionId,
        folder,
        repositoryUrl: repositoryUrl.trim() || undefined
      }
      const input: CreateProjectInput =
        type === 'latex'
          ? {
              ...base,
              type: 'latex',
              latex: {
                mainFile: mainFile.trim() || 'main.tex',
                contextFolder: contextFolder.trim() || 'context',
                overleafUrl: overleafUrl.trim() || undefined
              }
            }
          : { ...base, type: 'terminal' }
      await onCreate(input)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">NEW WORKSPACE</span>
            <h2 id="new-project-title">Add a {definition.label} project</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="project-type-grid" aria-label="Project type">
            {Object.values(projectTypeRegistry).map((item) => {
              const Icon = item.id === 'latex' ? FileText : TerminalSquare
              return (
                <button
                  type="button"
                  key={item.id}
                  className={type === item.id ? 'selected' : ''}
                  onClick={() => setType(item.id)}
                >
                  <Icon size={19} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                </button>
              )
            })}
          </div>

          <label className="field">
            <span>Connection</span>
            <select
              value={connectionId}
              onChange={(event) => {
                setConnectionId(event.target.value)
                setFolder('')
                setName('')
                setNameEdited(false)
                setRemoteListing(null)
                setError('')
              }}
            >
              {connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.kind === 'local' ? 'This Mac' : item.name}
                </option>
              ))}
            </select>
          </label>

          <div className="connection-preview">
            {connection?.kind === 'ssh' ? <Server size={17} /> : <Laptop size={17} />}
            <div>
              <strong>{connection?.name}</strong>
              <span>
                {connection?.kind === 'ssh'
                  ? `SSH alias · ${connection.sshAlias}`
                  : 'Local files and persistent terminals'}
              </span>
            </div>
          </div>

          <label className="field">
            <span>Project folder</span>
            <div className="field-row">
              <input
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
                placeholder={connection?.kind === 'ssh' ? '/home/you/project' : 'Choose a folder'}
                autoFocus
              />
              <button
                type="button"
                className="secondary-button square"
                onClick={() =>
                  connection?.kind === 'ssh'
                    ? void browseRemote(folder.trim() || undefined)
                    : void chooseFolder()
                }
                disabled={connection?.kind === 'ssh' && remoteLoading}
                title={
                  connection?.kind === 'ssh'
                    ? 'Browse the entered remote path'
                    : 'Choose a local folder'
                }
              >
                <FolderOpen size={17} />
              </button>
            </div>
          </label>
          {connection?.kind === 'ssh' && (
            <div className="remote-folder-browser">
              <div className="remote-folder-heading">
                <Server size={13} />
                <span>{remoteListing?.currentPath || 'Connecting…'}</span>
                {remoteLoading && <LoaderCircle className="spin" size={14} />}
              </div>
              <div className="remote-folder-list">
                {remoteListing?.parentPath && (
                  <button
                    type="button"
                    onClick={() => void browseRemote(remoteListing.parentPath!)}
                  >
                    <ChevronUp size={15} />
                    <span>..</span>
                  </button>
                )}
                {remoteListing?.entries.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    onClick={() => void browseRemote(entry.path)}
                  >
                    <Folder size={15} />
                    <span>{entry.name}</span>
                  </button>
                ))}
                {!remoteLoading && remoteListing?.entries.length === 0 && (
                  <p>This folder has no subfolders.</p>
                )}
              </div>
              <small>
                Browse folders or type an absolute path above. The entered path
                will be used when the project is created.
              </small>
            </div>
          )}

          <label className="field">
            <span>Project name</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameEdited(true)
              }}
              placeholder="My project"
            />
          </label>

          {type === 'latex' && (
            <div className="latex-create-fields">
              <div className="field-pair">
                <label className="field">
                  <span>Main LaTeX file</span>
                  <input
                    value={mainFile}
                    onChange={(event) => setMainFile(event.target.value)}
                    placeholder="main.tex"
                  />
                </label>
                <label className="field">
                  <span>Context folder</span>
                  <input
                    value={contextFolder}
                    onChange={(event) => setContextFolder(event.target.value)}
                    placeholder="context"
                  />
                </label>
              </div>
              <p className="form-help">
                Paths are relative to the project folder. The context folder is optional and may
                contain notes, sources, and reference material for attached agents.
              </p>
              <label className="field">
                <span>
                  <Link2 size={12} /> Overleaf URL <small>optional</small>
                </span>
                <input
                  value={overleafUrl}
                  onChange={(event) => setOverleafUrl(event.target.value)}
                  placeholder="https://www.overleaf.com/project/…"
                />
              </label>
            </div>
          )}

          <label className="field">
            <span>
              <Github size={12} /> Repository URL <small>optional</small>
            </span>
            <input
              value={repositoryUrl}
              onChange={(event) => setRepositoryUrl(event.target.value)}
              placeholder="Auto-detected locally, or paste a GitHub URL"
            />
          </label>

          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={submitting || !name || !folder || (type === 'latex' && !mainFile)}
            >
              {submitting ? 'Creating…' : `Create ${definition.label} project`}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
