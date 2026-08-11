import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { RotateCcw, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { normalizeProjectIcon } from '@shared/project-icon'
import { useModalEscape } from '../lib/modalEscape'
import '../project-icon.css'

const suggestions = ['✦', '⌘', 'λ', '∑', '⚡', '🧪', '🛰️', '🛠️', '📚', '🤖']

interface Props {
  project: Project
  x: number
  y: number
  onSave(icon: string | null): Promise<void>
  onClose(): void
}

export function ProjectIconMenu({ project, x, y, onSave, onClose }: Props) {
  const [value, setValue] = useState(project.icon ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  useModalEscape(onClose, true, saving)

  useEffect(() => {
    function closeOutside(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (!target.closest('.project-icon-menu')) onClose()
    }
    window.addEventListener('mousedown', closeOutside)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('mousedown', closeOutside)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  async function save(nextValue: string | null) {
    setError('')
    try {
      const icon = normalizeProjectIcon(nextValue)
      setSaving(true)
      await onSave(icon)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  const width = 252
  const height = 244
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8))
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8))

  return createPortal(
    <section
      className="project-icon-menu"
      role="dialog"
      aria-labelledby="project-icon-menu-title"
      style={{ left, top, width }}
    >
      <header>
        <div>
          <small>PROJECT MARK</small>
          <strong id="project-icon-menu-title">{project.name}</strong>
        </div>
        <button onClick={onClose} aria-label="Close icon picker" disabled={saving}>
          <X size={13} />
        </button>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          void save(value)
        }}
      >
        <label>
          <span>One symbol or emoji</span>
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="🚀"
            maxLength={32}
            autoFocus
            disabled={saving}
          />
        </label>
        <div className="project-icon-suggestions" aria-label="Suggested icons">
          {suggestions.map((suggestion) => (
            <button
              type="button"
              key={suggestion}
              className={value === suggestion ? 'selected' : ''}
              onClick={() => setValue(suggestion)}
              disabled={saving}
            >
              {suggestion}
            </button>
          ))}
        </div>
        {error && <p>{error}</p>}
        <footer>
          {project.icon && (
            <button
              type="button"
              className="project-icon-reset"
              onClick={() => void save(null)}
              disabled={saving}
            >
              <RotateCcw size={12} /> Reset
            </button>
          )}
          <button
            type="submit"
            className="project-icon-save"
            disabled={saving || !value.trim()}
          >
            {saving ? 'Saving…' : 'Use icon'}
          </button>
        </footer>
      </form>
    </section>,
    document.body
  )
}
