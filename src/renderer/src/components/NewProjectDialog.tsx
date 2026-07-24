import { useEffect, useState } from 'react'
import { ChevronUp, Folder, FolderOpen, Laptop, LoaderCircle, Server, X } from 'lucide-react'
import type {
  Connection,
  CreateProjectInput,
  RemoteFolderListing
} from '@shared/types'

interface Props {
  connections: Connection[]
  initialConnectionId?: string
  onClose(): void
  onCreate(input: CreateProjectInput): Promise<void>
}

export function NewProjectDialog({
  connections,
  initialConnectionId,
  onClose,
  onCreate
}: Props) {
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [connectionId, setConnectionId] = useState(
    initialConnectionId ?? connections[0]?.id ?? 'local'
  )
  const [folder, setFolder] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [remoteListing, setRemoteListing] = useState<RemoteFolderListing | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const connection = connections.find((item) => item.id === connectionId)

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
      await onCreate({ name, connectionId, folder })
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
            <h2 id="new-project-title">Add a terminal project</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
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
                  : 'Local folders and terminals'}
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
                readOnly={connection?.kind === 'ssh'}
                autoFocus
              />
              {connection?.kind === 'local' && (
                <button type="button" className="secondary-button square" onClick={chooseFolder}>
                  <FolderOpen size={17} />
                </button>
              )}
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
              <small>Open folders to browse. The path above is the folder that will be used.</small>
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
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={submitting || !name || !folder}>
              {submitting ? 'Creating…' : 'Create project'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
