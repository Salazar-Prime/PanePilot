import { useMemo, useState } from 'react'
import { ArrowRight, FolderInput, X } from 'lucide-react'
import type { Project, TerminalSession } from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'

interface Props {
  session: TerminalSession
  sourceProject: Project
  projects: Project[]
  onTransfer(targetProjectId: string): Promise<void>
  onClose(): void
}

export function TransferSessionDialog({
  session,
  sourceProject,
  projects,
  onTransfer,
  onClose
}: Props) {
  const destinations = useMemo(
    () =>
      projects
        .filter(
          (project) =>
            !project.archived &&
            project.id !== sourceProject.id &&
            project.connectionId === sourceProject.connectionId
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    [projects, sourceProject.connectionId, sourceProject.id]
  )
  const [targetProjectId, setTargetProjectId] = useState(
    destinations[0]?.id ?? ''
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useModalEscape(onClose, true, busy)

  async function transfer() {
    if (!targetProjectId) return
    setBusy(true)
    setError('')
    try {
      await onTransfer(targetProjectId)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      setBusy(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={() => !busy && onClose()}
    >
      <section
        className="modal transfer-session-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-session-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">SAME MACHINE</span>
            <h2 id="transfer-session-title">Transfer session to project</h2>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close transfer dialog"
          >
            <X size={17} />
          </button>
        </div>

        <div className="transfer-session-source">
          <FolderInput size={17} />
          <span>
            <strong>{session.name}</strong>
            <small>Currently in {sourceProject.name}</small>
          </span>
        </div>

        {destinations.length > 0 ? (
          <>
            <label className="field">
              <span>DESTINATION PROJECT</span>
              <select
                value={targetProjectId}
                onChange={(event) => setTargetProjectId(event.target.value)}
                disabled={busy}
              >
                {destinations.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name} — {project.folder}
                  </option>
                ))}
              </select>
            </label>
            <p className="transfer-session-note">
              PanePilot moves the tab and retags its tmux metadata. A process
              that is already running keeps its current working directory until
              it is restarted; a later force reload or resume starts from the
              destination project folder.
            </p>
            {error && <p className="form-error">{error}</p>}
            <div className="modal-actions">
              <button
                className="secondary-button"
                onClick={onClose}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className="primary-button"
                onClick={() => void transfer()}
                disabled={busy || !targetProjectId}
              >
                <ArrowRight size={14} /> {busy ? 'Transferring…' : 'Transfer'}
              </button>
            </div>
          </>
        ) : (
          <div className="transfer-session-empty">
            <strong>No compatible destination</strong>
            <p>
              Create another project on this same local or SSH machine before
              transferring this session.
            </p>
            <button className="secondary-button" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
