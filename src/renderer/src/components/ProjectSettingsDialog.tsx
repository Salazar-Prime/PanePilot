import { useState } from 'react'
import { Folder, X } from 'lucide-react'
import type { Connection, Project } from '@shared/types'

interface Props {
  project: Project
  connection?: Connection
  onClose(): void
  onRename(name: string): Promise<void>
}

export function ProjectSettingsDialog({
  project,
  connection,
  onClose,
  onRename
}: Props) {
  const [name, setName] = useState(project.name)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const cleaned = name.trim()
    if (!cleaned || cleaned === project.name) {
      onClose()
      return
    }
    setSaving(true)
    setError('')
    try {
      await onRename(cleaned)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PROJECT SETTINGS</span>
            <h2 id="project-settings-title">Edit project</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Project name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          <div className="project-location-summary">
            <Folder size={16} />
            <div>
              <strong>{connection?.name || 'Connection'}</strong>
              <span>{project.folder}</span>
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
