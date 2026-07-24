import { useEffect, useMemo, useState } from 'react'
import {
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type { Project, ProjectAction } from '@shared/types'
import { ManagedTerminal } from './ManagedTerminal'
import { StatusDot } from './StatusDot'

interface Props {
  project: Project
  onChanged(): Promise<void>
}

export function ActionsPanel({ project, onChanged }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    project.actions[0]?.id ?? null
  )
  const [editing, setEditing] = useState<ProjectAction | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const selected =
    project.actions.find((action) => action.id === selectedId) ??
    project.actions[0] ??
    null
  const session = useMemo(
    () =>
      selected?.lastSessionId
        ? project.sessions.find(
            (candidate) => candidate.id === selected.lastSessionId
          ) ?? null
        : null,
    [project.sessions, selected?.lastSessionId]
  )
  const running =
    session != null && !['completed', 'error'].includes(session.state)

  useEffect(() => {
    if (selectedId && project.actions.some((action) => action.id === selectedId)) {
      return
    }
    setSelectedId(project.actions[0]?.id ?? null)
  }, [project.actions, selectedId])

  async function perform(operation: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      await onChanged()
      setBusy(false)
    }
  }

  async function runAction() {
    if (!selected) return
    await perform(() => window.projectConsole.actions.run(selected.id))
  }

  async function stopAction() {
    if (!selected) return
    await perform(() => window.projectConsole.actions.stop(selected.id))
  }

  async function deleteAction() {
    if (!selected) return
    if (
      !window.confirm(
        `Delete “${selected.name}” and its last run output?`
      )
    ) {
      return
    }
    await perform(() => window.projectConsole.actions.delete(selected.id))
  }

  return (
    <section className="actions-panel">
      <aside className="actions-list">
        <header>
          <div>
            <span className="eyebrow">PROJECT COMMANDS</span>
            <strong>Actions</strong>
          </div>
          <button
            className="icon-button"
            title="New action"
            onClick={() => setEditing('new')}
          >
            <Plus size={15} />
          </button>
        </header>
        <div className="actions-list-scroll">
          {project.actions.map((action) => {
            const actionSession = action.lastSessionId
              ? project.sessions.find(
                  (candidate) => candidate.id === action.lastSessionId
                )
              : null
            return (
              <button
                key={action.id}
                className={selected?.id === action.id ? 'active' : ''}
                onClick={() => setSelectedId(action.id)}
              >
                <Play size={13} />
                <span>
                  <strong>{action.name}</strong>
                  <small>{action.command}</small>
                </span>
                {actionSession && (
                  <StatusDot state={actionSession.state} compact />
                )}
              </button>
            )
          })}
          {project.actions.length === 0 && (
            <div className="actions-list-empty">
              <Play size={22} />
              <span>No actions yet</span>
              <small>Save a shell command to run it on demand.</small>
            </div>
          )}
        </div>
      </aside>

      <div className="action-runner">
        {selected ? (
          <>
            <header className="action-runner-heading">
              <div>
                <span className="eyebrow">ACTION</span>
                <strong>{selected.name}</strong>
                <code>{selected.command}</code>
              </div>
              <div>
                <button
                  className="secondary-button"
                  onClick={() => setEditing(selected)}
                  disabled={busy}
                >
                  <Pencil size={13} /> Edit
                </button>
                {running ? (
                  <button
                    className="secondary-button danger-text"
                    onClick={() => void stopAction()}
                    disabled={busy}
                  >
                    <Square size={13} /> Stop
                  </button>
                ) : (
                  <button
                    className="primary-button"
                    onClick={() => void runAction()}
                    disabled={busy}
                  >
                    {session ? <RotateCcw size={13} /> : <Play size={13} />}
                    {session ? 'Run again' : 'Run'}
                  </button>
                )}
                <button
                  className="icon-button danger-text"
                  title="Delete action"
                  onClick={() => void deleteAction()}
                  disabled={busy}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </header>
            {error && <p className="action-error">{error}</p>}
            <div className="action-terminal">
              {session ? (
                <ManagedTerminal session={session} />
              ) : (
                <div className="capability-empty">
                  <Play size={32} />
                  <h3>Ready to run</h3>
                  <p>
                    Each run uses a fresh tmux session. Only the latest run’s
                    output is kept.
                  </p>
                </div>
              )}
            </div>
            <footer className="action-runner-footer">
              <span>
                {running
                  ? 'Running — type in the output pane if the command asks for input.'
                  : session
                    ? 'Run finished. Running again replaces this output.'
                    : 'The run finishes when the command exits.'}
              </span>
            </footer>
          </>
        ) : (
          <div className="capability-empty">
            <Play size={35} />
            <h2>Reusable project actions</h2>
            <p>
              Save commands such as tests, builds, deployments, or local
              maintenance scripts.
            </p>
            <button className="primary-button" onClick={() => setEditing('new')}>
              <Plus size={14} /> New action
            </button>
          </div>
        )}
      </div>

      {editing && (
        <ActionEditor
          projectId={project.id}
          action={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (action) => {
            setEditing(null)
            setSelectedId(action.id)
            await onChanged()
          }}
        />
      )}
    </section>
  )
}

function ActionEditor({
  projectId,
  action,
  onClose,
  onSaved
}: {
  projectId: string
  action: ProjectAction | null
  onClose(): void
  onSaved(action: ProjectAction): Promise<void>
}) {
  const [name, setName] = useState(action?.name ?? '')
  const [command, setCommand] = useState(action?.command ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      const saved = action
        ? await window.projectConsole.actions.update({
            actionId: action.id,
            name,
            command
          })
        : await window.projectConsole.actions.create({
            projectId,
            name,
            command
          })
      await onSaved(saved)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal action-editor-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-editor-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">
              {action ? 'EDIT ACTION' : 'NEW ACTION'}
            </span>
            <h2 id="action-editor-title">
              {action ? action.name : 'Save a project command'}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Run tests"
              maxLength={80}
              autoFocus
            />
          </label>
          <label className="field">
            <span>Shell command</span>
            <textarea
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npm test"
              rows={6}
              maxLength={4_096}
            />
          </label>
          <p className="field-help">
            Runs from the project folder in a fresh ephemeral tmux session.
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={saving || !name.trim() || !command.trim()}
            >
              {saving ? 'Saving…' : action ? 'Save changes' : 'Create action'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
