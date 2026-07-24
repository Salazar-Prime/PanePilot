import Editor, { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { useEffect, useState } from 'react'
import {
  ChevronRight,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Pencil,
  RefreshCw,
  Save,
  X
} from 'lucide-react'
import type { FileEntry, FilePreview, Project } from '@shared/types'

loader.config({ monaco })
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker()
    if (['css', 'scss', 'less'].includes(label)) return new cssWorker()
    if (['html', 'handlebars', 'razor'].includes(label)) return new htmlWorker()
    if (['typescript', 'javascript'].includes(label)) return new tsWorker()
    return new editorWorker()
  }
}

export function FilesPanel({
  project,
  initialPath = '.'
}: {
  project: Project
  initialPath?: string
}) {
  const [path, setPath] = useState(initialPath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  function canLeaveEditor(): boolean {
    return (
      !editing ||
      !preview ||
      draft === preview.content ||
      window.confirm('Discard your unsaved file changes?')
    )
  }

  async function load(nextPath = path) {
    if (!canLeaveEditor()) return
    setLoading(true)
    setError('')
    try {
      setEntries(await window.projectConsole.files.list(project.id, nextPath))
      setPath(nextPath)
      setPreview(null)
      setDraft('')
      setEditing(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setPath(initialPath)
    setPreview(null)
    setEditing(false)
    void load(initialPath)
  }, [project.id, initialPath])

  const pathParts = path === '.' ? [] : path.split('/')

  async function openEntry(entry: FileEntry) {
    if (entry.kind === 'directory') {
      await load(entry.path)
      return
    }
    if (!canLeaveEditor()) return
    setError('')
    try {
      const nextPreview = await window.projectConsole.files.preview(project.id, entry.path)
      setPreview(nextPreview)
      setDraft(nextPreview.content)
      setEditing(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function save() {
    if (!preview) return
    setSaving(true)
    setError('')
    try {
      await window.projectConsole.files.save(project.id, preview.path, draft)
      setPreview({ ...preview, content: draft })
      setEditing(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="files-layout">
      <aside className="file-browser">
        <div className="file-browser-header">
          <div className="breadcrumbs">
            <button onClick={() => void load('.')}>
              <FolderOpen size={14} />
              {project.name}
            </button>
            {pathParts.map((part, index) => (
              <span key={`${part}-${index}`}>
                <ChevronRight size={13} />
                <button onClick={() => void load(pathParts.slice(0, index + 1).join('/'))}>
                  {part}
                </button>
              </span>
            ))}
          </div>
          <button className="icon-button" onClick={() => void load()} aria-label="Refresh files">
            <RefreshCw size={15} className={loading ? 'spin' : ''} />
          </button>
        </div>
        {error ? (
          <div className="file-error">
            <p>{error}</p>
          </div>
        ) : (
          <div className="file-list">
            {path !== '.' && (
              <button
                className="file-row"
                onClick={() => {
                  const parent = path.split('/').slice(0, -1).join('/') || '.'
                  void load(parent)
                }}
              >
                <Folder size={16} />
                <span>..</span>
              </button>
            )}
            {entries.map((entry) => (
              <button
                key={entry.path}
                className={`file-row ${preview?.path === entry.path ? 'selected' : ''}`}
                onClick={() => void openEntry(entry)}
              >
                {entry.kind === 'directory' ? <Folder size={16} /> : <File size={16} />}
                <span>{entry.name}</span>
                {entry.size != null && <small>{formatBytes(entry.size)}</small>}
              </button>
            ))}
          </div>
        )}
      </aside>
      <main className="file-preview">
        {preview ? (
          <>
            <div className="preview-header">
              <FileCode2 size={16} />
              <span>{preview.path}</span>
              {preview.truncated && <small>First 1 MB · editing disabled</small>}
              {!preview.binary && !preview.truncated && (
                <div className="preview-actions">
                  {editing ? (
                    <>
                      <button
                        className="secondary-button"
                        onClick={() => {
                          setDraft(preview.content)
                          setEditing(false)
                        }}
                        disabled={saving}
                      >
                        <X size={13} /> Cancel
                      </button>
                      <button
                        className="primary-button"
                        onClick={() => void save()}
                        disabled={saving || draft === preview.content}
                      >
                        <Save size={13} /> {saving ? 'Saving…' : 'Save'}
                      </button>
                    </>
                  ) : (
                    <button className="secondary-button" onClick={() => setEditing(true)}>
                      <Pencil size={13} /> Edit
                    </button>
                  )}
                </div>
              )}
            </div>
            {preview.binary ? (
              <div className="preview-empty">Binary files can’t be previewed.</div>
            ) : (
              <div className="file-editor-shell">
                <Editor
                  path={preview.path}
                  language={languageForPath(preview.path)}
                  theme="vs-dark"
                  value={editing ? draft : preview.content}
                  onChange={(value) => setDraft(value ?? '')}
                  options={{
                    readOnly: !editing,
                    domReadOnly: !editing,
                    minimap: { enabled: false },
                    fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
                    fontSize: 12,
                    lineHeight: 20,
                    padding: { top: 14 },
                    renderLineHighlight: editing ? 'line' : 'none',
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    wordWrap: 'on'
                  }}
                />
              </div>
            )}
          </>
        ) : (
          <div className="preview-empty">
            <FileCode2 size={32} />
            <p>Select a file to preview it.</p>
            <span>Choose Edit before making changes.</span>
          </div>
        )}
      </main>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function languageForPath(path: string): string {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase()
  const languages: Record<string, string> = {
    c: 'c',
    cpp: 'cpp',
    css: 'css',
    go: 'go',
    html: 'html',
    java: 'java',
    js: 'javascript',
    json: 'json',
    jsx: 'javascript',
    md: 'markdown',
    py: 'python',
    rb: 'ruby',
    rs: 'rust',
    sh: 'shell',
    sql: 'sql',
    ts: 'typescript',
    tsx: 'typescript',
    xml: 'xml',
    yaml: 'yaml',
    yml: 'yaml'
  }
  return (extension && languages[extension]) || 'plaintext'
}
