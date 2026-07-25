import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  Download,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Pencil,
  RefreshCw,
  Save,
  Search,
  X
} from 'lucide-react'
import type { FileEntry, FilePreview, Project } from '@shared/types'
import type { ProjectFileOpenRequest } from '../lib/terminalFileLinks'
import { Editor, monaco } from '../lib/monaco'

interface FilesPanelProps {
  project: Project
  initialPath?: string
  openFileRequest?: ProjectFileOpenRequest | null
}

interface FilesPanelSnapshot {
  path: string
  entries: FileEntry[]
  preview: FilePreview | null
  draft: string
  editing: boolean
  loaded: boolean
  searchQuery: string
  searchResults: FileEntry[]
}

const filesPanelCache = new Map<string, FilesPanelSnapshot>()

export function FilesPanel(props: FilesPanelProps) {
  return <FilesPanelInstance key={props.project.id} {...props} />
}

function FilesPanelInstance({
  project,
  initialPath = '.',
  openFileRequest = null
}: FilesPanelProps) {
  const cached = filesPanelCache.get(project.id)
  const [path, setPath] = useState(cached?.path ?? initialPath)
  const [entries, setEntries] = useState<FileEntry[]>(cached?.entries ?? [])
  const [preview, setPreview] = useState<FilePreview | null>(
    cached?.preview ?? null
  )
  const [draft, setDraft] = useState(cached?.draft ?? '')
  const [editing, setEditing] = useState(cached?.editing ?? false)
  const [loaded, setLoaded] = useState(cached?.loaded ?? false)
  const [searchQuery, setSearchQuery] = useState(cached?.searchQuery ?? '')
  const [searchResults, setSearchResults] = useState<FileEntry[]>(
    cached?.searchResults ?? []
  )
  const [searching, setSearching] = useState(false)
  const [searchRevision, setSearchRevision] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const pendingRevealRef = useRef<ProjectFileOpenRequest | null>(null)
  const initialPathRef = useRef(initialPath)

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
      setLoaded(true)
      pendingRevealRef.current = null
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!loaded) void load(initialPath)
  }, [])

  useEffect(() => {
    if (initialPathRef.current === initialPath) return
    initialPathRef.current = initialPath
    void load(initialPath)
  }, [initialPath])

  useEffect(() => {
    filesPanelCache.set(project.id, {
      path,
      entries,
      preview,
      draft,
      editing,
      loaded,
      searchQuery,
      searchResults
    })
  }, [
    draft,
    editing,
    entries,
    loaded,
    path,
    preview,
    project.id,
    searchQuery,
    searchResults
  ])

  useEffect(() => {
    const query = searchQuery.trim()
    if (!query) {
      setSearching(false)
      setSearchResults([])
      setError('')
      return
    }
    let active = true
    const timer = window.setTimeout(() => {
      setSearching(true)
      setError('')
      void window.projectConsole.files
        .search(project.id, query)
        .then((results) => {
          if (active) setSearchResults(results)
        })
        .catch((caught) => {
          if (active) {
            setError(caught instanceof Error ? caught.message : String(caught))
          }
        })
        .finally(() => {
          if (active) setSearching(false)
        })
    }, 220)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [project.id, searchQuery, searchRevision])

  const pathParts = path === '.' ? [] : path.split('/')
  const searchingPaths = Boolean(searchQuery.trim())
  const displayedEntries = searchingPaths ? searchResults : entries

  async function openFile(
    filePath: string,
    request: ProjectFileOpenRequest | null = null
  ) {
    if (!canLeaveEditor()) return
    setLoading(true)
    setError('')
    try {
      const parent =
        filePath.split('/').slice(0, -1).join('/') || '.'
      const [nextEntries, nextPreview] = await Promise.all([
        window.projectConsole.files.list(project.id, parent),
        window.projectConsole.files.preview(project.id, filePath)
      ])
      setEntries(nextEntries)
      setPath(parent)
      setPreview(nextPreview)
      setDraft(nextPreview.content)
      setEditing(false)
      pendingRevealRef.current = request
      if (nextPreview.binary) editorRef.current = null
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  async function openEntry(entry: FileEntry) {
    if (entry.kind === 'directory') {
      await navigate(entry.path)
      return
    }
    await openFile(entry.path)
  }

  async function navigate(nextPath: string) {
    setSearchQuery('')
    await load(nextPath)
  }

  function revealRequestedPosition(
    editor = editorRef.current
  ): void {
    const request = pendingRevealRef.current
    if (
      !editor ||
      !request ||
      !preview ||
      request.path !== preview.path ||
      request.line == null
    ) {
      return
    }
    const position = {
      lineNumber: Math.max(1, request.line),
      column: Math.max(1, request.column ?? 1)
    }
    editor.setPosition(position)
    editor.revealPositionInCenter(position)
    editor.focus()
  }

  useEffect(() => {
    if (
      !openFileRequest ||
      openFileRequest.projectId !== project.id
    ) {
      return
    }
    void openFile(openFileRequest.path, openFileRequest)
  }, [openFileRequest?.requestId])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      revealRequestedPosition()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [preview?.path, openFileRequest?.requestId])

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

  async function download() {
    if (!preview) return
    setDownloading(true)
    setError('')
    try {
      await window.projectConsole.files.download(project.id, preview.path)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="files-layout">
      <aside className="file-browser">
        <div className="file-browser-header">
          <div className="breadcrumbs">
            <button onClick={() => void navigate('.')}>
              <FolderOpen size={14} />
              {project.name}
            </button>
            {pathParts.map((part, index) => (
              <span key={`${part}-${index}`}>
                <ChevronRight size={13} />
                <button
                  onClick={() =>
                    void navigate(pathParts.slice(0, index + 1).join('/'))
                  }
                >
                  {part}
                </button>
              </span>
            ))}
          </div>
          <button
            className="icon-button"
            onClick={() => {
              if (searchingPaths) {
                setSearchRevision((current) => current + 1)
              } else {
                void load()
              }
            }}
            aria-label={searchingPaths ? 'Refresh file search' : 'Refresh files'}
          >
            <RefreshCw size={15} className={loading || searching ? 'spin' : ''} />
          </button>
        </div>
        <div className="file-search">
          <Search size={14} />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Search project paths"
            aria-label="Search project files"
          />
          {searching ? (
            <RefreshCw className="spin" size={13} />
          ) : searchQuery ? (
            <button
              onClick={() => setSearchQuery('')}
              aria-label="Clear file search"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
        {error ? (
          <div className="file-error">
            <p>{error}</p>
          </div>
        ) : (
          <div className="file-list">
            {path !== '.' && !searchingPaths && (
              <button
                className="file-row"
                onClick={() => {
                  const parent = path.split('/').slice(0, -1).join('/') || '.'
                  void navigate(parent)
                }}
              >
                <Folder size={16} />
                <span>..</span>
              </button>
            )}
            {displayedEntries.map((entry) => (
              <button
                key={entry.path}
                className={`file-row ${preview?.path === entry.path ? 'selected' : ''}`}
                onClick={() => void openEntry(entry)}
              >
                {entry.kind === 'directory' ? <Folder size={16} /> : <File size={16} />}
                <span>{searchingPaths ? entry.path : entry.name}</span>
                {entry.size != null && <small>{formatBytes(entry.size)}</small>}
              </button>
            ))}
            {searchingPaths && !searching && displayedEntries.length === 0 && (
              <div className="file-search-empty">
                No project paths match “{searchQuery.trim()}”.
              </div>
            )}
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
              <div className="preview-actions">
                <button
                  className="secondary-button"
                  onClick={() => void download()}
                  disabled={downloading}
                  title="Download the saved project file"
                >
                  <Download size={13} />{' '}
                  {downloading ? 'Downloading…' : 'Download'}
                </button>
                {!preview.binary &&
                  !preview.truncated &&
                  (editing ? (
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
                  ))}
              </div>
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
                  onMount={(editor) => {
                    editorRef.current = editor
                    revealRequestedPosition(editor)
                  }}
                  options={{
                    automaticLayout: true,
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
