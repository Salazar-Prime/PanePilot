import { useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  CloudUpload,
  Copy,
  Download,
  ExternalLink,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Save,
  Search,
  X
} from 'lucide-react'
import type {
  FileEntry,
  FilePreview,
  GoogleDriveUploadResult,
  Project
} from '@shared/types'
import { addShowInFinderAction } from '../lib/monacoFinderAction'
import type { ProjectFileOpenRequest } from '../lib/terminalFileLinks'
import { Editor, monaco } from '../lib/monaco'

interface FilesPanelProps {
  project: Project
  initialPath?: string
  openFileRequest?: ProjectFileOpenRequest | null
  onChanged?(): Promise<void>
}

interface FilesPanelSnapshot {
  path: string
  entries: FileEntry[]
  openFiles: OpenFileTab[]
  activeFilePath: string | null
  loaded: boolean
  searchQuery: string
  searchResults: FileEntry[]
}

interface OpenFileTab {
  preview: FilePreview
  draft: string
  editing: boolean
}

const filesPanelCache = new Map<string, FilesPanelSnapshot>()

function uniqueEntries(entries: FileEntry[]): FileEntry[] {
  const unique = new Map<string, FileEntry>()
  for (const entry of entries) unique.set(entry.path, entry)
  return [...unique.values()]
}

export function FilesPanel(props: FilesPanelProps) {
  return <FilesPanelInstance key={props.project.id} {...props} />
}

function FilesPanelInstance({
  project,
  initialPath = '.',
  openFileRequest = null,
  onChanged
}: FilesPanelProps) {
  const cached = filesPanelCache.get(project.id)
  const [listing, setListing] = useState(() => ({
    path: cached?.path ?? initialPath,
    entries: uniqueEntries(cached?.entries ?? []),
    loaded: cached?.loaded ?? false
  }))
  const [openFiles, setOpenFiles] = useState<OpenFileTab[]>(
    cached?.openFiles ?? []
  )
  const [activeFilePath, setActiveFilePath] = useState<string | null>(
    cached?.activeFilePath ?? cached?.openFiles.at(-1)?.preview.path ?? null
  )
  const [searchQuery, setSearchQuery] = useState(cached?.searchQuery ?? '')
  const [searchResults, setSearchResults] = useState<FileEntry[]>(
    uniqueEntries(cached?.searchResults ?? [])
  )
  const [searching, setSearching] = useState(false)
  const [searchRevision, setSearchRevision] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [uploadingToDrive, setUploadingToDrive] = useState(false)
  const [driveMessage, setDriveMessage] = useState('')
  const [driveUpload, setDriveUpload] = useState<GoogleDriveUploadResult | null>(
    null
  )
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const finderActionRef = useRef<{ dispose(): void } | null>(null)
  const activeFinderPathRef = useRef<string | null>(null)
  const pendingRevealRef = useRef<ProjectFileOpenRequest | null>(null)
  const initialPathRef = useRef(initialPath)
  const listingRequestRef = useRef(0)
  const path = listing.path
  const entries = listing.entries
  const loaded = listing.loaded
  const activeFile =
    openFiles.find((file) => file.preview.path === activeFilePath) ?? null
  const preview = activeFile?.preview ?? null
  const draft = activeFile?.draft ?? ''
  const editing = activeFile?.editing ?? false
  activeFinderPathRef.current = preview?.path ?? null

  useEffect(() => {
    setDriveMessage('')
    setDriveUpload(null)
  }, [preview?.path])

  function updateOpenFile(
    filePath: string,
    update: (file: OpenFileTab) => OpenFileTab
  ): void {
    setOpenFiles((current) =>
      current.map((file) =>
        file.preview.path === filePath ? update(file) : file
      )
    )
  }

  async function load(nextPath = path) {
    const request = ++listingRequestRef.current
    setLoading(true)
    setError('')
    try {
      const nextEntries = await window.projectConsole.files.list(
        project.id,
        nextPath
      )
      if (request !== listingRequestRef.current) return
      setListing({
        path: nextPath,
        entries: uniqueEntries(nextEntries),
        loaded: true
      })
    } catch (caught) {
      if (request !== listingRequestRef.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === listingRequestRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    if (!loaded) void load(initialPath)
  }, [])

  useEffect(
    () => () => {
      finderActionRef.current?.dispose()
    },
    []
  )

  useEffect(() => {
    if (initialPathRef.current === initialPath) return
    initialPathRef.current = initialPath
    void load(initialPath)
  }, [initialPath])

  useEffect(() => {
    filesPanelCache.set(project.id, {
      path,
      entries,
      openFiles,
      activeFilePath,
      loaded,
      searchQuery,
      searchResults
    })
  }, [
    activeFilePath,
    listing,
    openFiles,
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
          if (active) setSearchResults(uniqueEntries(results))
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
  const displayedEntries = uniqueEntries(searchingPaths ? searchResults : entries)

  function addOpenFile(nextPreview: FilePreview): void {
    setOpenFiles((current) => {
      if (current.some((file) => file.preview.path === nextPreview.path)) {
        return current
      }
      return [
        ...current,
        {
          preview: nextPreview,
          draft: nextPreview.content,
          editing: false
        }
      ]
    })
    setActiveFilePath(nextPreview.path)
    if (nextPreview.binary) editorRef.current = null
  }

  async function openFile(filePath: string) {
    const existingFile = openFiles.find(
      (file) => file.preview.path === filePath
    )
    if (existingFile) {
      setActiveFilePath(filePath)
      pendingRevealRef.current = null
      return
    }
    const listingRequest = ++listingRequestRef.current
    setLoading(true)
    setError('')
    try {
      const parent = filePath.split('/').slice(0, -1).join('/') || '.'
      const [nextEntries, nextPreview] = await Promise.all([
        parent === path
          ? Promise.resolve(entries)
          : window.projectConsole.files.list(project.id, parent),
        window.projectConsole.files.preview(project.id, filePath)
      ])
      if (listingRequest !== listingRequestRef.current) return
      setListing({
        path: parent,
        entries: uniqueEntries(nextEntries),
        loaded: true
      })
      pendingRevealRef.current = null
      addOpenFile(nextPreview)
    } catch (caught) {
      if (listingRequest !== listingRequestRef.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (listingRequest === listingRequestRef.current) setLoading(false)
    }
  }

  async function openLinkedPath(openRequest: ProjectFileOpenRequest) {
    const listingRequest = ++listingRequestRef.current
    setLoading(true)
    setError('')
    try {
      const result = await window.projectConsole.files.open(
        project.id,
        openRequest.path
      )
      if (listingRequest !== listingRequestRef.current) return
      setSearchQuery('')
      setListing({
        path: result.directoryPath,
        entries: uniqueEntries(result.entries),
        loaded: true
      })
      if (result.kind === 'directory') {
        pendingRevealRef.current = null
        return
      }
      if (!result.preview) throw new Error('The file could not be previewed.')
      pendingRevealRef.current = openRequest
      addOpenFile(result.preview)
    } catch (caught) {
      if (listingRequest !== listingRequestRef.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (listingRequest === listingRequestRef.current) setLoading(false)
    }
  }

  function closeFile(filePath: string): void {
    const index = openFiles.findIndex(
      (file) => file.preview.path === filePath
    )
    if (index < 0) return
    const file = openFiles[index]
    if (
      file.editing &&
      file.draft !== file.preview.content &&
      !window.confirm('Discard your unsaved file changes?')
    ) {
      return
    }
    const remaining = openFiles.filter(
      (candidate) => candidate.preview.path !== filePath
    )
    setOpenFiles(remaining)
    if (activeFilePath === filePath) {
      setActiveFilePath(
        remaining[Math.min(index, remaining.length - 1)]?.preview.path ?? null
      )
      pendingRevealRef.current = null
      editorRef.current = null
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
    void openLinkedPath(openFileRequest)
  }, [openFileRequest?.requestId])

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      revealRequestedPosition()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [preview?.path, openFileRequest?.requestId])

  useEffect(() => {
    setDriveMessage('')
  }, [preview?.path])

  async function save() {
    if (!preview) return
    const filePath = preview.path
    const savedDraft = draft
    setSaving(true)
    setError('')
    try {
      await window.projectConsole.files.save(project.id, filePath, savedDraft)
      updateOpenFile(filePath, (file) => ({
        ...file,
        preview: { ...file.preview, content: savedDraft },
        editing: file.draft !== savedDraft
      }))
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

  async function uploadToDrive() {
    if (!preview) return
    setUploadingToDrive(true)
    setDriveMessage('')
    setDriveUpload(null)
    setError('')
    try {
      const status = await window.projectConsole.googleDrive.status(project.id)
      if (!status.connected) {
        throw new Error(
          'Connect an rclone Drive account and folder from the project toolbar first.'
        )
      }
      const result = await window.projectConsole.googleDrive.uploadFile(
        project.id,
        preview.path
      )
      setDriveUpload(result)
      setDriveMessage(
        `${result.updated ? 'Updated' : 'Uploaded'} ${preview.path} → ${result.destination}`
      )
      void onChanged?.().catch(() => undefined)
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (!/canceled/i.test(message)) setError(message)
    } finally {
      setUploadingToDrive(false)
    }
  }

  async function copyDriveLink() {
    if (!driveUpload) return
    try {
      await navigator.clipboard.writeText(driveUpload.webViewLink)
      setDriveMessage(`Copied Drive link for ${driveUpload.name}`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function showPathInFinder(filePath: string) {
    setError('')
    try {
      await window.projectConsole.files.showInFolder(project.id, filePath)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function showInFinder() {
    if (preview) await showPathInFinder(preview.path)
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
          <div
            className="file-list"
            key={`${project.id}:${path}:${searchQuery.trim()}`}
          >
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
        {openFiles.length > 0 && (
          <div className="file-preview-tabs" role="tablist" aria-label="Open files">
            {openFiles.map((file) => {
              const selected = file.preview.path === activeFilePath
              const dirty = file.draft !== file.preview.content
              return (
                <div
                  className={`file-preview-tab ${selected ? 'selected' : ''}`}
                  key={file.preview.path}
                >
                  <button
                    className="file-preview-tab-select"
                    role="tab"
                    aria-selected={selected}
                    title={file.preview.path}
                    onClick={() => {
                      setActiveFilePath(file.preview.path)
                      pendingRevealRef.current = null
                    }}
                  >
                    {file.preview.imageMimeType ? (
                      <ImageIcon size={13} />
                    ) : (
                      <FileCode2 size={13} />
                    )}
                    <span>{fileName(file.preview.path)}</span>
                    {dirty && <i aria-label="Unsaved changes" />}
                  </button>
                  <button
                    className="file-preview-tab-close"
                    aria-label={`Close ${fileName(file.preview.path)}`}
                    title="Close file"
                    onClick={() => closeFile(file.preview.path)}
                  >
                    <X size={12} />
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {preview ? (
          <>
            <div className="preview-header">
              {preview.imageMimeType ? (
                <ImageIcon size={16} />
              ) : (
                <FileCode2 size={16} />
              )}
              <span>{preview.path}</span>
              {preview.truncated && (
                <small>
                  {preview.imageMimeType
                    ? 'Image exceeds 1 MB · preview disabled'
                    : 'First 1 MB · editing disabled'}
                </small>
              )}
              {driveMessage && (
                <small className="drive-upload-result">{driveMessage}</small>
              )}
              <div className="preview-actions">
                {driveUpload && (
                  <>
                    <button
                      className="secondary-button"
                      onClick={() => void copyDriveLink()}
                      title="Copy the private Google Drive link"
                    >
                      <Copy size={13} /> Copy Drive link
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        void window.projectConsole.system.openExternal(
                          driveUpload.webViewLink
                        )
                      }
                      title="Open this uploaded file in Google Drive"
                    >
                      <ExternalLink size={13} /> Open in Drive
                    </button>
                  </>
                )}
                {project.connectionId === 'local' && (
                  <button
                    className="secondary-button"
                    onClick={() => void showInFinder()}
                    title="Reveal the saved project file in Finder"
                  >
                    <FolderOpen size={13} /> Show in Finder
                  </button>
                )}
                <button
                  className="secondary-button drive-upload-button"
                  onClick={() => void uploadToDrive()}
                  disabled={
                    uploadingToDrive ||
                    (editing && draft !== preview.content)
                  }
                  title={
                    editing && draft !== preview.content
                      ? 'Save or cancel your edits before uploading the saved file'
                      : 'Upload the authoritative saved file to this project’s Google Drive folder'
                  }
                >
                  <CloudUpload size={13} />{' '}
                  {uploadingToDrive ? 'Uploading…' : 'Upload to Drive'}
                </button>
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
                          updateOpenFile(preview.path, (file) => ({
                            ...file,
                            draft: file.preview.content,
                            editing: false
                          }))
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
                    <button
                      className="secondary-button"
                      onClick={() =>
                        updateOpenFile(preview.path, (file) => ({
                          ...file,
                          editing: true
                        }))
                      }
                    >
                      <Pencil size={13} /> Edit
                    </button>
                  ))}
              </div>
            </div>
            {preview.imageDataUrl ? (
              <div className="file-image-preview">
                <img
                  src={preview.imageDataUrl}
                  alt={fileName(preview.path)}
                />
              </div>
            ) : preview.imageMimeType ? (
              <div className="preview-empty">
                This image is larger than the 1 MB preview limit. Download it to
                view the full file.
              </div>
            ) : preview.binary ? (
              <div className="preview-empty">Binary files can’t be previewed.</div>
            ) : (
              <div className="file-editor-shell">
                <Editor
                  path={`${project.id}/${preview.path}`}
                  language={languageForPath(preview.path)}
                  theme="vs-dark"
                  value={editing ? draft : preview.content}
                  onChange={(value) =>
                    updateOpenFile(preview.path, (file) => ({
                      ...file,
                      draft: value ?? ''
                    }))
                  }
                  onMount={(editor) => {
                    editorRef.current = editor
                    finderActionRef.current?.dispose()
                    if (project.connectionId === 'local') {
                      finderActionRef.current = addShowInFinderAction(
                        editor,
                        async () => {
                          const filePath = activeFinderPathRef.current
                          if (filePath) await showPathInFinder(filePath)
                        }
                      )
                    }
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

function fileName(path: string): string {
  return path.split('/').at(-1) || path
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
