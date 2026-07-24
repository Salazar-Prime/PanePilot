import { useState } from 'react'
import { FileText, Folder, Github, Link2, X } from 'lucide-react'
import type { Connection, Project } from '@shared/types'

interface Props {
  project: Project
  connection?: Connection
  onClose(): void
  onRename(name: string): Promise<void>
  onChanged(): Promise<void>
}

export function ProjectSettingsDialog({
  project,
  connection,
  onClose,
  onRename,
  onChanged
}: Props) {
  const [name, setName] = useState(project.name)
  const [repositoryUrl, setRepositoryUrl] = useState(project.repositoryUrl ?? '')
  const [mainFile, setMainFile] = useState(project.latex?.mainFile ?? 'main.tex')
  const [contextFolder, setContextFolder] = useState(
    project.latex?.contextFolder ?? 'context'
  )
  const [overleafUrl, setOverleafUrl] = useState(project.latex?.overleafUrl ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const cleaned = name.trim()
    if (!cleaned) return
    setSaving(true)
    setError('')
    try {
      if (cleaned !== project.name) await onRename(cleaned)
      const nextRepositoryUrl = repositoryUrl.trim() || null
      if (nextRepositoryUrl !== project.repositoryUrl) {
        await window.projectConsole.projects.updateRepository(
          project.id,
          nextRepositoryUrl
        )
      }
      if (project.type === 'latex') {
        await window.projectConsole.latex.update({
          projectId: project.id,
          mainFile,
          contextFolder,
          overleafUrl: overleafUrl.trim() || undefined
        })
      }
      await onChanged()
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-settings-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">PROJECT SETTINGS</span>
            <h2 id="project-settings-title">Edit project</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Project name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
          </label>
          {project.type === 'latex' && (
            <div className="latex-settings-fields">
              <div className="field-pair">
                <label className="field">
                  <span>
                    <FileText size={12} /> Main LaTeX file
                  </span>
                  <input
                    value={mainFile}
                    onChange={(event) => setMainFile(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>Context folder</span>
                  <input
                    value={contextFolder}
                    onChange={(event) => setContextFolder(event.target.value)}
                  />
                </label>
              </div>
              <label className="field">
                <span>
                  <Link2 size={12} /> Overleaf URL
                </span>
                <input
                  value={overleafUrl}
                  onChange={(event) => setOverleafUrl(event.target.value)}
                  placeholder="https://www.overleaf.com/project/…"
                />
              </label>
            </div>
          )}
          <label className="field">
            <span>
              <Github size={12} /> Repository URL
            </span>
            <input
              value={repositoryUrl}
              onChange={(event) => setRepositoryUrl(event.target.value)}
              placeholder="https://github.com/owner/repository"
            />
          </label>
          <div className="project-location-summary">
            <Folder size={16} />
            <div>
              <strong>{connection?.name || 'Connection'}</strong>
              <span>{project.folder}</span>
            </div>
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button className="primary-button" disabled={saving || !name.trim()}>
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
