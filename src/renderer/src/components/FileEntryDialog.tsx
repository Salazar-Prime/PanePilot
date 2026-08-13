import { useState } from 'react'
import { createPortal } from 'react-dom'
import { FilePlus2, FolderPlus, Pencil, X } from 'lucide-react'
import { useModalEscape } from '../lib/modalEscape'

export type FileEntryDialogMode = 'create-file' | 'create-directory' | 'rename'

interface Props {
  mode: FileEntryDialogMode
  location: string
  initialValue?: string
  onSubmit(name: string): Promise<void>
  onClose(): void
}

export function FileEntryDialog({
  mode,
  location,
  initialValue = '',
  onSubmit,
  onClose
}: Props) {
  const [name, setName] = useState(initialValue)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useModalEscape(onClose, true, busy)

  const creatingFile = mode === 'create-file'
  const creatingDirectory = mode === 'create-directory'
  const title = creatingFile
    ? 'Create file'
    : creatingDirectory
      ? 'Create folder'
      : 'Rename item'
  const Icon = creatingFile ? FilePlus2 : creatingDirectory ? FolderPlus : Pencil

  async function submit() {
    const cleaned = name.trim()
    if (!cleaned) return
    setBusy(true)
    setError('')
    try {
      await onSubmit(cleaned)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return createPortal(
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => !busy && onClose()}
    >
      <section
        className="modal file-entry-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="file-entry-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PROJECT FILES</span>
            <h2 id="file-entry-dialog-title">{title}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            <X size={17} />
          </button>
        </div>
        <div className="file-entry-location">
          <Icon size={15} />
          <span>{location}</span>
        </div>
        <label className="field">
          <span>{creatingDirectory ? 'FOLDER NAME' : 'FILE NAME'}</span>
          <input
            autoFocus
            value={name}
            maxLength={255}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void submit()
              }
            }}
            placeholder={creatingDirectory ? 'new-folder' : 'new-file.md'}
            disabled={busy}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            className="primary-button"
            onClick={() => void submit()}
            disabled={busy || !name.trim()}
          >
            <Icon size={14} /> {busy ? 'Working…' : title}
          </button>
        </div>
      </section>
    </div>,
    document.body
  )
}
