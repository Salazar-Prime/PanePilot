import { useEffect, useState } from 'react'
import { ChevronRight, File, FileCode2, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { FileEntry, FilePreview, Project } from '@shared/types'

export function FilesPanel({ project }: { project: Project }) {
  const [path, setPath] = useState('.')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [preview, setPreview] = useState<FilePreview | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function load(nextPath = path) {
    setLoading(true)
    setError('')
    try {
      setEntries(await window.projectConsole.files.list(project.id, nextPath))
      setPath(nextPath)
      setPreview(null)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setPath('.')
    void load('.')
  }, [project.id])

  const pathParts = path === '.' ? [] : path.split('/')

  async function openEntry(entry: FileEntry) {
    if (entry.kind === 'directory') {
      await load(entry.path)
      return
    }
    setError('')
    try {
      setPreview(await window.projectConsole.files.preview(project.id, entry.path))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
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
          <div className="inline-empty">
            <Folder size={25} />
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
              {preview.truncated && <small>First 1 MB</small>}
            </div>
            {preview.binary ? (
              <div className="preview-empty">Binary files can’t be previewed.</div>
            ) : (
              <pre>{preview.content}</pre>
            )}
          </>
        ) : (
          <div className="preview-empty">
            <FileCode2 size={32} />
            <p>Select a file to preview it.</p>
            <span>Files are opened read-only.</span>
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
