import { useEffect, useState } from 'react'
import { FolderOpen, Laptop, Server, X } from 'lucide-react'
import type { Connection, CreateProjectInput } from '@shared/types'

interface Props {
  connections: Connection[]
  onClose(): void
  onCreate(input: CreateProjectInput): Promise<void>
}

export function NewProjectDialog({ connections, onClose, onCreate }: Props) {
  const [name, setName] = useState('')
  const [connectionId, setConnectionId] = useState(connections[0]?.id ?? 'local')
  const [folder, setFolder] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const connection = connections.find((item) => item.id === connectionId)

  useEffect(() => {
    if (!name && folder) {
      const parts = folder.replace(/\/+$/, '').split('/')
      setName(parts.at(-1) ?? '')
    }
  }, [folder, name])

  async function chooseFolder() {
    const selected = await window.projectConsole.projects.chooseFolder()
    if (selected) setFolder(selected)
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
            <select value={connectionId} onChange={(event) => setConnectionId(event.target.value)}>
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
                autoFocus
              />
              {connection?.kind === 'local' && (
                <button type="button" className="secondary-button square" onClick={chooseFolder}>
                  <FolderOpen size={17} />
                </button>
              )}
            </div>
          </label>
          <label className="field">
            <span>Project name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
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
