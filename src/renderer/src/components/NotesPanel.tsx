import { useEffect, useRef, useState } from 'react'
import {
  FilePlus2,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  X
} from 'lucide-react'
import type {
  Project,
  ProjectNote,
  ProjectNoteSummary
} from '@shared/types'
import { Editor, monaco } from '../lib/monaco'
import { addShowInFinderAction } from '../lib/monacoFinderAction'

type NoteDialog =
  | { mode: 'create'; initialName: '' }
  | { mode: 'rename'; initialName: string }

export function NotesPanel({ project }: { project: Project }) {
  const [notes, setNotes] = useState<ProjectNoteSummary[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [note, setNote] = useState<ProjectNote | null>(null)
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [dialog, setDialog] = useState<NoteDialog | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const saveRef = useRef<() => void>(() => undefined)
  const finderActionRef = useRef<{ dispose(): void } | null>(null)
  const activeFinderPathRef = useRef<string | null>(null)
  const dirty = note != null && draft !== saved
  activeFinderPathRef.current = note
    ? `.panepilot/notes/${note.path}`
    : null

  function canDiscard(): boolean {
    return (
      !dirty ||
      window.confirm('Discard your unsaved project note changes?')
    )
  }

  async function loadNote(path: string) {
    const next = await window.projectConsole.notes.read(project.id, path)
    setSelectedPath(next.path)
    setNote(next)
    setSaved(next.content)
    setDraft(next.content)
  }

  async function refresh(
    preferredPath: string | null = selectedPath,
    confirmDiscard = true
  ) {
    if (confirmDiscard && !canDiscard()) return
    setLoading(true)
    setError('')
    try {
      const nextNotes = await window.projectConsole.notes.list(project.id)
      setNotes(nextNotes)
      const nextPath =
        (preferredPath &&
        nextNotes.some((candidate) => candidate.path === preferredPath)
          ? preferredPath
          : nextNotes[0]?.path) ?? null
      if (nextPath) {
        await loadNote(nextPath)
      } else {
        setSelectedPath(null)
        setNote(null)
        setSaved('')
        setDraft('')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  async function select(path: string) {
    if (path === selectedPath || !canDiscard()) return
    setLoading(true)
    setError('')
    try {
      await loadNote(path)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    if (!note || !dirty || saving) return
    const content = draft
    setSaving(true)
    setError('')
    try {
      const next = await window.projectConsole.notes.write(
        project.id,
        note.path,
        content
      )
      setNote(next)
      setSaved(next.content)
      setDraft((current) => current === content ? next.content : current)
      setNotes((current) =>
        current.map((candidate) =>
          candidate.path === next.path ? next : candidate
        )
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  async function create(name: string) {
    setLoading(true)
    setError('')
    try {
      const created = await window.projectConsole.notes.create(project.id, name)
      setDialog(null)
      await refresh(created.path, false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      throw caught
    } finally {
      setLoading(false)
    }
  }

  async function rename(name: string) {
    if (!note || !canDiscard()) return
    setLoading(true)
    setError('')
    try {
      const renamed = await window.projectConsole.notes.rename(
        project.id,
        note.path,
        name
      )
      setDialog(null)
      await refresh(renamed.path, false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      throw caught
    } finally {
      setLoading(false)
    }
  }

  async function remove() {
    if (
      !note ||
      !window.confirm(
        `Delete “${note.name}” from .panepilot/notes? This removes the Markdown file from the project folder.`
      )
    ) {
      return
    }
    setLoading(true)
    setError('')
    try {
      await window.projectConsole.notes.delete(project.id, note.path)
      setNote(null)
      setSaved('')
      setDraft('')
      await refresh(null, false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  saveRef.current = () => {
    void save()
  }

  useEffect(() => {
    setNotes([])
    setSelectedPath(null)
    setNote(null)
    setSaved('')
    setDraft('')
    setError('')
    void refresh(null, false)
  }, [project.id])

  useEffect(
    () => () => {
      finderActionRef.current?.dispose()
    },
    []
  )

  async function showActiveNoteInFinder() {
    const filePath = activeFinderPathRef.current
    if (!filePath) return
    setError('')
    try {
      await window.projectConsole.files.showInFolder(project.id, filePath)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <section className="notes-layout">
      <aside className="notes-list">
        <header>
          <div>
            <span className="eyebrow">SHARED MARKDOWN</span>
            <strong>Notes</strong>
          </div>
          <button
            className="icon-button"
            title="New note"
            onClick={() => {
              if (canDiscard()) {
                setDialog({ mode: 'create', initialName: '' })
              }
            }}
          >
            <Plus size={15} />
          </button>
        </header>
        <div className="notes-list-scroll">
          {notes.map((candidate) => (
            <button
              key={candidate.path}
              className={candidate.path === selectedPath ? 'active' : ''}
              onClick={() => void select(candidate.path)}
            >
              <FileText size={14} />
              <span>
                <strong>{candidate.name}</strong>
                <small>.panepilot/notes/{candidate.path}</small>
              </span>
            </button>
          ))}
          {!notes.length && !loading && (
            <div className="notes-list-empty">
              <FilePlus2 size={24} />
              <span>No notes yet</span>
              <small>Create a Markdown note shared through the project folder.</small>
            </div>
          )}
        </div>
      </aside>

      <main className="notes-panel">
        {note ? (
          <>
            <header className="notes-header">
              <div>
                <FileText size={17} />
                <span>
                  <strong>{note.name}</strong>
                  <small>.panepilot/notes/{note.path} · Markdown</small>
                </span>
              </div>
              <div className="notes-actions">
                <span className={dirty ? 'notes-dirty' : ''}>
                  {loading ? 'Loading…' : dirty ? 'Unsaved changes' : 'Saved'}
                </span>
                <button
                  className="icon-button"
                  title="Rename note"
                  onClick={() =>
                    setDialog({ mode: 'rename', initialName: note.name })
                  }
                  disabled={loading || saving}
                >
                  <Pencil size={13} />
                </button>
                <button
                  className="icon-button danger-text"
                  title="Delete note"
                  onClick={() => void remove()}
                  disabled={loading || saving}
                >
                  <Trash2 size={13} />
                </button>
                <button
                  className="secondary-button"
                  onClick={() => void refresh(note.path)}
                  disabled={loading || saving}
                >
                  <RefreshCw size={13} className={loading ? 'spin' : ''} /> Reload
                </button>
                <button
                  className="primary-button"
                  onClick={() => void save()}
                  disabled={!dirty || loading || saving}
                >
                  <Save size={13} /> {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </header>
            {error && <div className="notes-error">{error}</div>}
            <div className="notes-editor-shell">
              <Editor
                path={`panepilot-notes/${project.id}/${note.path}`}
                language="markdown"
                theme="vs-dark"
                value={draft}
                onChange={(value) => setDraft(value ?? '')}
                onMount={(editor) => {
                  editor.addCommand(
                    monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
                    () => saveRef.current()
                  )
                  finderActionRef.current?.dispose()
                  if (project.connectionId === 'local') {
                    finderActionRef.current = addShowInFinderAction(
                      editor,
                      showActiveNoteInFinder
                    )
                  }
                  editor.focus()
                }}
                options={{
                  automaticLayout: true,
                  minimap: { enabled: false },
                  fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
                  fontSize: 13,
                  lineHeight: 21,
                  padding: { top: 18, bottom: 18 },
                  scrollBeyondLastLine: false,
                  smoothScrolling: true,
                  wordWrap: 'on',
                  wrappingIndent: 'same'
                }}
              />
            </div>
            <footer className="notes-footer">
              <span>⌘S to save</span>
              <span>
                {new TextEncoder().encode(draft).length.toLocaleString()} bytes · 1 MB maximum
              </span>
            </footer>
          </>
        ) : (
          <div className="capability-empty">
            <FilePlus2 size={35} />
            <h2>Shared project notes</h2>
            <p>
              Notes are Markdown files under <code>.panepilot/notes</code> and
              travel with this project.
            </p>
            {error && <p className="form-error">{error}</p>}
            <button
              className="primary-button"
              onClick={() => {
                if (canDiscard()) {
                  setDialog({ mode: 'create', initialName: '' })
                }
              }}
              disabled={loading}
            >
              <Plus size={14} /> New note
            </button>
          </div>
        )}
      </main>

      {dialog && (
        <NoteNameDialog
          mode={dialog.mode}
          initialName={dialog.initialName}
          onClose={() => setDialog(null)}
          onSubmit={dialog.mode === 'create' ? create : rename}
        />
      )}
    </section>
  )
}

function NoteNameDialog({
  mode,
  initialName,
  onClose,
  onSubmit
}: {
  mode: 'create' | 'rename'
  initialName: string
  onClose(): void
  onSubmit(name: string): Promise<void>
}) {
  const [name, setName] = useState(initialName)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      await onSubmit(name)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal note-name-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="note-name-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">
              {mode === 'create' ? 'NEW NOTE' : 'RENAME NOTE'}
            </span>
            <h2 id="note-name-title">
              {mode === 'create' ? 'Create a Markdown note' : 'Rename note'}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Note name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Decisions"
              maxLength={80}
              autoFocus
            />
          </label>
          <p className="field-help">
            PanePilot stores this as <code>.panepilot/notes/&lt;name&gt;.md</code>.
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create note' : 'Rename note'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
