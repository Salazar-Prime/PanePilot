import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  X
} from 'lucide-react'
import type { Project, ProjectAction } from '@shared/types'
import { ManagedTerminal } from './ManagedTerminal'
import { SortableActionsList } from './SortableActionsList'
import type { TerminalFileTarget } from '../lib/terminalFileLinks'
import { useModalEscape } from '../lib/modalEscape'
import { loadActionSelection, resolveActionSelection, saveActionSelection } from '../lib/actionSelection'

interface Props {
  project: Project
  sessionRequest?: { id: number; sessionId: string } | null
  onSessionRequestHandled?(id: number): void
  onChanged(): Promise<void>
  onOpenFile?(target: TerminalFileTarget): void
}

export function ActionsPanel(props: Props) {
  return <ActionsPanelInstance key={props.project.id} {...props} />
}

function ActionsPanelInstance({ project, sessionRequest, onSessionRequestHandled, onChanged, onOpenFile }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(
    () => project.actions.find((action) => action.lastSessionId === sessionRequest?.sessionId)?.id ??
      resolveActionSelection(project.actions, loadActionSelection(project.id))
  )
  const handledRequestRef = useRef<number | null>(null)
  const [editing, setEditing] = useState<ProjectAction | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
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
    if (!sessionRequest || handledRequestRef.current === sessionRequest.id) return
    const action = project.actions.find((item) => item.lastSessionId === sessionRequest?.sessionId)
    if (action) {
      handledRequestRef.current = sessionRequest.id
      setSelectedId(action.id)
      onSessionRequestHandled?.(sessionRequest.id)
    }
  }, [project.actions, sessionRequest?.id, onSessionRequestHandled])

  useEffect(() => {
    if (selectedId && project.actions.some((action) => action.id === selectedId)) {
      return
    }
    setSelectedId(resolveActionSelection(project.actions, loadActionSelection(project.id)))
  }, [project.id, project.actions, selectedId])

  useEffect(() => {
    if (selectedId && project.actions.some((action) => action.id === selectedId)) {
      saveActionSelection(project.id, selectedId)
    }
  }, [project.id, project.actions, selectedId])

  useEffect(() => {
    void syncActions()
  }, [project.id])

  async function syncActions() {
    setSyncing(true)
    setError('')
    try {
      await window.projectConsole.actions.sync(project.id)
      await onChanged()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSyncing(false)
    }
  }

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
          <div className="actions-list-heading-actions">
            <button
              className="icon-button"
              title="Refresh shared Actions"
              onClick={() => void syncActions()}
              disabled={syncing}
            >
              <RefreshCw size={14} className={syncing ? 'spin' : ''} />
            </button>
            <button
              className="icon-button"
              title="New action"
              onClick={() => setEditing('new')}
            >
              <Plus size={15} />
            </button>
          </div>
        </header>
        {error && <p className="action-error">{error}</p>}
        <SortableActionsList key={project.id} projectId={project.id}
          actions={project.actions} sessions={project.sessions}
          selectedId={selected?.id ?? null} onSelect={setSelectedId} />
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
            <div className="action-terminal">
              {session ? (
                <ManagedTerminal
                  session={session}
                  retainOutputOnExit
                  projectFolder={project.folder}
                  onOpenFile={onOpenFile}
                />
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
                    ? session.state === 'error'
                      ? 'Run failed. Its output is retained until you run it again.'
                      : 'Run finished. Running again replaces this output.'
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
  useModalEscape(onClose, true, saving)

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
              type="submit"
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
