import { useEffect, useRef, useState } from 'react'
import { FileText, RefreshCw, Save } from 'lucide-react'
import type { Project } from '@shared/types'
import { Editor, monaco } from '../lib/monaco'

export function NotesPanel({ project }: { project: Project }) {
  const [saved, setSaved] = useState('')
  const [draft, setDraft] = useState('')
  const [exists, setExists] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const saveRef = useRef<() => void>(() => undefined)
  const dirty = draft !== saved

  async function load(confirmDiscard = false) {
    if (
      confirmDiscard &&
      dirty &&
      !window.confirm('Discard your unsaved project note changes and reload from disk?')
    ) {
      return
    }
    setLoading(true)
    setError('')
    try {
      const notes = await window.projectConsole.notes.read(project.id)
      setSaved(notes.content)
      setDraft(notes.content)
      setExists(notes.exists)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  async function save() {
    if (!dirty || saving) return
    const content = draft
    setSaving(true)
    setError('')
    try {
      const notes = await window.projectConsole.notes.write(project.id, content)
      setSaved(notes.content)
      setDraft((current) =>
        current === content ? notes.content : current
      )
      setExists(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  saveRef.current = () => {
    void save()
  }

  useEffect(() => {
    setSaved('')
    setDraft('')
    setExists(false)
    setLoading(true)
    setError('')
    void load()
  }, [project.id])

  return (
    <section className="notes-panel">
      <header className="notes-header">
        <div>
          <FileText size={17} />
          <span>
            <strong>Project notes</strong>
            <small>
              .notes-panepilot · Markdown · {exists ? 'stored with the project' : 'created on first save'}
            </small>
          </span>
        </div>
        <div className="notes-actions">
          <span className={dirty ? 'notes-dirty' : ''}>
            {loading ? 'Loading…' : dirty ? 'Unsaved changes' : 'Saved'}
          </span>
          <button
            className="secondary-button"
            onClick={() => void load(true)}
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
          path={`panepilot-notes/${project.id}/notes.md`}
          language="markdown"
          theme="vs-dark"
          value={draft}
          onChange={(value) => setDraft(value ?? '')}
          onMount={(editor) => {
            editor.addCommand(
              monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
              () => saveRef.current()
            )
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
        <span>{new TextEncoder().encode(draft).length.toLocaleString()} bytes · 1 MB maximum</span>
      </footer>
    </section>
  )
}
