import { useEffect, useState } from 'react'
import { X } from 'lucide-react'

interface Props {
  title: string
  eyebrow: string
  label: string
  initialValue: string
  description?: string
  maxLength?: number
  onClose(): void
  onRename(name: string): Promise<void>
}

export function RenameDialog({
  title,
  eyebrow,
  label,
  initialValue,
  description,
  maxLength,
  onClose,
  onRename
}: Props) {
  const [name, setName] = useState(initialValue)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose, saving])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const cleaned = name.trim()
    if (!cleaned || cleaned === initialValue) {
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
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => {
        if (!saving) onClose()
      }}
    >
      <section
        className="modal rename-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id="rename-dialog-title">{title}</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
            disabled={saving}
          >
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>{label}</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
              maxLength={maxLength}
              onFocus={(event) => event.currentTarget.select()}
            />
          </label>
          {description && <p className="form-help">{description}</p>}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={saving || !name.trim()}
            >
              {saving ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
