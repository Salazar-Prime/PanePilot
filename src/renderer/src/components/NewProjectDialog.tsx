import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronUp,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Github,
  Laptop,
  Link2,
  LoaderCircle,
  Server,
  TerminalSquare,
  X
} from 'lucide-react'
import type {
  Connection,
  CreateProjectInput,
  ProjectType,
  RemoteFolderListing
} from '@shared/types'
import { projectTypeRegistry } from '../projectTypeRegistry'
import { useModalEscape } from '../lib/modalEscape'
import {
  newProjectFolderDestination,
  type ProjectFolderMode,
  rankedRemoteBrowserEntries,
  remoteFolderFilterQuery,
  remoteFolderInputValue,
  remoteFolderSlashTarget,
  suggestedProjectName
} from '../lib/projectCreation'

interface Props {
  connections: Connection[]
  initialConnectionId?: string
  initialProjectType?: ProjectType
  onClose(): void
  onCreate(input: CreateProjectInput): Promise<void>
}

export function NewProjectDialog({
  connections,
  initialConnectionId,
  initialProjectType = 'terminal',
  onClose,
  onCreate
}: Props) {
  const [type, setType] = useState<ProjectType>(initialProjectType)
  const [name, setName] = useState('')
  const [nameEdited, setNameEdited] = useState(false)
  const [connectionId, setConnectionId] = useState(
    initialConnectionId ?? connections[0]?.id ?? 'local'
  )
  const [folderMode, setFolderMode] =
    useState<ProjectFolderMode>('existing')
  const [folder, setFolder] = useState('')
  const [newFolderName, setNewFolderName] = useState('')
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const [mainFile, setMainFile] = useState('main.tex')
  const [contextFolder, setContextFolder] = useState('context')
  const [overleafUrl, setOverleafUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [remoteListing, setRemoteListing] = useState<RemoteFolderListing | null>(null)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteSelectionIndex, setRemoteSelectionIndex] = useState(0)
  const remoteBrowseRequestRef = useRef(0)
  const connection = connections.find((item) => item.id === connectionId)
  const definition = projectTypeRegistry[type]
  const folderDestination = newProjectFolderDestination(folder, newFolderName)
  const remoteFilterQuery = remoteListing
    ? remoteFolderFilterQuery(remoteListing.currentPath, folder)
    : ''
  const remoteEntries = useMemo(
    () =>
      rankedRemoteBrowserEntries(
        remoteListing?.entries ?? [],
        remoteFilterQuery
      ),
    [remoteFilterQuery, remoteListing?.entries]
  )
  const remoteFolderEntries = useMemo(
    () => remoteEntries.filter((entry) => entry.kind === 'directory'),
    [remoteEntries]
  )
  const selectedRemoteFolder =
    remoteFolderEntries[
      Math.min(remoteSelectionIndex, Math.max(0, remoteFolderEntries.length - 1))
    ] ?? null
  useModalEscape(onClose, true, submitting)

  useEffect(() => {
    if (!nameEdited) {
      setName(suggestedProjectName(folderMode, folder, newFolderName))
    }
  }, [folder, folderMode, nameEdited, newFolderName])

  useEffect(() => {
    if (connection?.kind !== 'ssh') {
      remoteBrowseRequestRef.current += 1
      setRemoteListing(null)
      setRemoteLoading(false)
      return
    }
    void browseRemote()
  }, [connectionId])

  useEffect(() => {
    setRemoteSelectionIndex(0)
  }, [remoteFilterQuery, remoteListing?.currentPath])

  async function chooseFolder() {
    const selected = await window.projectConsole.projects.chooseFolder(
      folderMode === 'new' ? 'parent' : 'project'
    )
    if (selected) setFolder(selected)
  }

  async function browseRemote(path?: string) {
    const request = ++remoteBrowseRequestRef.current
    setRemoteLoading(true)
    setError('')
    try {
      const listing = await window.projectConsole.remoteFolders.list(connectionId, path)
      if (request !== remoteBrowseRequestRef.current) return
      setRemoteListing(listing)
      setFolder(listing.currentPath)
      setRemoteSelectionIndex(0)
    } catch (caught) {
      if (request !== remoteBrowseRequestRef.current) return
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (request === remoteBrowseRequestRef.current) setRemoteLoading(false)
    }
  }

  function updateRemotePath(nextValue: string) {
    if (!remoteListing) {
      setFolder(nextValue)
      return
    }
    const next = remoteFolderInputValue(
      remoteListing.currentPath,
      folder,
      nextValue
    )
    setFolder(next)
    setRemoteSelectionIndex(0)
    const target = remoteFolderSlashTarget(
      remoteListing.currentPath,
      next,
      remoteListing.entries
    )
    if (target) void browseRemote(target)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      const base = {
        name: name.trim(),
        connectionId,
        folder: folder.trim(),
        newFolderName:
          folderMode === 'new' ? newFolderName.trim() : undefined,
        repositoryUrl: repositoryUrl.trim() || undefined
      }
      const input: CreateProjectInput =
        type === 'latex'
          ? {
              ...base,
              type: 'latex',
              latex: {
                mainFile: mainFile.trim() || 'main.tex',
                contextFolder: contextFolder.trim() || 'context',
                overleafUrl: overleafUrl.trim() || undefined
              }
            }
          : { ...base, type: 'terminal' }
      await onCreate(input)
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">NEW WORKSPACE</span>
            <h2 id="new-project-title">Add a {definition.label} project</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="project-type-grid" aria-label="Project type">
            {Object.values(projectTypeRegistry).map((item) => {
              const Icon = item.id === 'latex' ? FileText : TerminalSquare
              return (
                <button
                  type="button"
                  key={item.id}
                  className={type === item.id ? 'selected' : ''}
                  onClick={() => setType(item.id)}
                >
                  <Icon size={19} />
                  <span>
                    <strong>{item.label}</strong>
                    <small>{item.description}</small>
                  </span>
                </button>
              )
            })}
          </div>

          <label className="field">
            <span>Connection</span>
            <select
              value={connectionId}
              onChange={(event) => {
                remoteBrowseRequestRef.current += 1
                setConnectionId(event.target.value)
                setFolderMode('existing')
                setFolder('')
                setNewFolderName('')
                setName('')
                setNameEdited(false)
                setRemoteListing(null)
                setError('')
              }}
            >
              {connections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.kind === 'local' ? 'This Mac' : item.name}
                </option>
              ))}
            </select>
          </label>

          <div className="connection-preview">
            {connection?.kind === 'ssh' ? <Server size={17} /> : <Laptop size={17} />}
            <div>
              <strong>{connection?.name}</strong>
              <span>
                {connection?.kind === 'ssh'
                  ? `SSH alias · ${connection.sshAlias}`
                  : 'Local files and persistent terminals'}
              </span>
            </div>
          </div>

          {connection?.kind === 'ssh' ? (
            <div className="field remote-project-folder-field">
              <span>{folderMode === 'new' ? 'Create inside' : 'Project folder'}</span>
              <div className="remote-folder-browser">
                <div className="remote-folder-pathbar">
                  <button
                    type="button"
                    onClick={() =>
                      remoteListing?.parentPath &&
                      void browseRemote(remoteListing.parentPath)
                    }
                    disabled={!remoteListing?.parentPath || remoteLoading}
                    aria-label="Open parent folder"
                    title="Up one folder"
                  >
                    <ChevronUp size={15} />
                  </button>
                  <input
                    value={folder}
                    onChange={(event) => updateRemotePath(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        setRemoteSelectionIndex((current) =>
                          remoteFolderEntries.length === 0
                            ? 0
                            : (current + 1) % remoteFolderEntries.length
                        )
                        return
                      }
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        setRemoteSelectionIndex((current) =>
                          remoteFolderEntries.length === 0
                            ? 0
                            : (current - 1 + remoteFolderEntries.length) %
                              remoteFolderEntries.length
                        )
                        return
                      }
                      if (event.key === 'Tab' && selectedRemoteFolder) {
                        event.preventDefault()
                        setFolder(selectedRemoteFolder.path)
                        return
                      }
                      if (
                        event.key === '/' &&
                        remoteFilterQuery &&
                        selectedRemoteFolder
                      ) {
                        event.preventDefault()
                        void browseRemote(selectedRemoteFolder.path)
                        return
                      }
                      if (event.key !== 'Enter') return
                      event.preventDefault()
                      void browseRemote(
                        selectedRemoteFolder?.path ?? (folder.trim() || undefined)
                      )
                    }}
                    placeholder="Remote path"
                    aria-label="Remote project path"
                    spellCheck={false}
                    readOnly={remoteLoading}
                    autoFocus
                  />
                  {remoteLoading ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <button
                      type="button"
                      className={folderMode === 'new' ? 'selected' : ''}
                      aria-label={
                        folderMode === 'new'
                          ? 'Cancel new folder'
                          : 'Create a new project folder here'
                      }
                      aria-pressed={folderMode === 'new'}
                      title={
                        folderMode === 'new'
                          ? 'Use this folder'
                          : 'Create a new folder here'
                      }
                      onClick={() => {
                        const creating = folderMode !== 'new'
                        setFolderMode(creating ? 'new' : 'existing')
                        if (creating && remoteListing) {
                          setFolder(remoteListing.currentPath)
                        }
                        setNewFolderName('')
                        setError('')
                      }}
                    >
                      {folderMode === 'new' ? <X size={15} /> : <FolderPlus size={15} />}
                    </button>
                  )}
                </div>
                {folderMode === 'new' && (
                  <div className="remote-new-folder-row">
                    <FolderPlus size={15} />
                    <label>
                      <span>New folder</span>
                      <input
                        value={newFolderName}
                        onChange={(event) => setNewFolderName(event.target.value)}
                        placeholder="Folder name"
                        maxLength={255}
                        aria-label="New remote folder name"
                        autoFocus
                      />
                    </label>
                    <code>
                      {folderDestination || 'Enter a folder name'}
                    </code>
                  </div>
                )}
                <div
                  className="remote-folder-list"
                  role="listbox"
                  aria-label="Remote files and folders"
                >
                  {remoteEntries.map((entry) =>
                    entry.kind === 'directory' ? (
                      <button
                        type="button"
                        className={`remote-folder-entry ${selectedRemoteFolder?.path === entry.path ? 'selected' : ''}`}
                        key={entry.path}
                        onClick={() => void browseRemote(entry.path)}
                        onMouseEnter={() =>
                          setRemoteSelectionIndex(
                            remoteFolderEntries.findIndex(
                              (folderEntry) => folderEntry.path === entry.path
                            )
                          )
                        }
                        role="option"
                        aria-selected={selectedRemoteFolder?.path === entry.path}
                      >
                        <Folder size={15} />
                        <span>{entry.name}</span>
                        <small>Folder</small>
                      </button>
                    ) : (
                      <div
                        className="remote-folder-entry remote-file-entry"
                        key={entry.path}
                        title="Choose a folder to create or attach a project"
                      >
                        <File size={15} />
                        <span>{entry.name}</span>
                        <small>File</small>
                      </div>
                    )
                  )}
                  {!remoteLoading && remoteListing?.entries.length === 0 && (
                    <p>This folder is empty.</p>
                  )}
                  {!remoteLoading &&
                    remoteFilterQuery &&
                    remoteListing &&
                    remoteListing.entries.length > 0 &&
                    remoteEntries.length === 0 && (
                      <p>No files or folders match “{remoteFilterQuery}”.</p>
                    )}
                </div>
                <div className="remote-folder-status">
                  <span>
                    {remoteFilterQuery
                      ? `${remoteEntries.length} match${remoteEntries.length === 1 ? '' : 'es'}`
                      : `${remoteListing?.entries.filter((entry) => entry.kind === 'directory').length ?? 0} folders · ${
                          remoteListing?.entries.filter(
                            (entry) => entry.kind === 'file'
                          ).length ?? 0
                        } files`}
                  </span>
                  <small>↑↓ choose · Tab complete · / or Enter open</small>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div
                className="project-folder-mode"
                role="group"
                aria-label="Project folder setup"
              >
                <button
                  type="button"
                  className={folderMode === 'existing' ? 'selected' : ''}
                  aria-pressed={folderMode === 'existing'}
                  onClick={() => {
                    setFolderMode('existing')
                    setError('')
                  }}
                >
                  <FolderOpen size={17} />
                  <span>
                    <strong>Use existing folder</strong>
                    <small>Attach a folder that already exists</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={folderMode === 'new' ? 'selected' : ''}
                  aria-pressed={folderMode === 'new'}
                  onClick={() => {
                    setFolderMode('new')
                    setError('')
                  }}
                >
                  <FolderPlus size={17} />
                  <span>
                    <strong>Create new folder</strong>
                    <small>Choose a location, then name the folder</small>
                  </span>
                </button>
              </div>
              <label className="field">
                <span>{folderMode === 'new' ? 'Create inside' : 'Project folder'}</span>
                <div className="field-row">
                  <input
                    value={folder}
                    onChange={(event) => setFolder(event.target.value)}
                    placeholder={
                      folderMode === 'new'
                        ? 'Choose a parent folder'
                        : 'Choose a folder'
                    }
                    autoFocus
                  />
                  <button
                    type="button"
                    className="secondary-button square"
                    onClick={() => void chooseFolder()}
                    title={
                      folderMode === 'new'
                        ? 'Choose where to create the folder'
                        : 'Choose a local folder'
                    }
                  >
                    <FolderOpen size={17} />
                  </button>
                </div>
              </label>
              {folderMode === 'new' && (
                <>
                  <label className="field">
                    <span>New folder name</span>
                    <input
                      value={newFolderName}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder="my-project"
                      maxLength={255}
                    />
                  </label>
                  <div className="new-project-folder-preview">
                    <FolderPlus size={16} />
                    <span>
                      <small>New project location</small>
                      <code>
                        {folderDestination || 'Choose a location and folder name'}
                      </code>
                    </span>
                  </div>
                </>
              )}
            </>
          )}

          <label className="field">
            <span>Project name</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setNameEdited(true)
              }}
              placeholder="My project"
            />
          </label>

          {type === 'latex' && (
            <div className="latex-create-fields">
              <div className="field-pair">
                <label className="field">
                  <span>Main LaTeX file</span>
                  <input
                    value={mainFile}
                    onChange={(event) => setMainFile(event.target.value)}
                    placeholder="main.tex"
                  />
                </label>
                <label className="field">
                  <span>Context folder</span>
                  <input
                    value={contextFolder}
                    onChange={(event) => setContextFolder(event.target.value)}
                    placeholder="context"
                  />
                </label>
              </div>
              <p className="form-help">
                Paths are relative to the project folder. The context folder is
                optional and may contain notes, sources, and reference material
                for attached agents.
                {folderMode === 'new' &&
                  ' PanePilot creates the configured main file with a minimal LaTeX document.'}
              </p>
              <label className="field">
                <span>
                  <Link2 size={12} /> Overleaf URL <small>optional</small>
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
              <Github size={12} /> Repository URL <small>optional</small>
            </span>
            <input
              value={repositoryUrl}
              onChange={(event) => setRepositoryUrl(event.target.value)}
              placeholder="Auto-detected locally, or paste a GitHub URL"
            />
          </label>

          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={
                submitting ||
                !name.trim() ||
                !folder.trim() ||
                (folderMode === 'new' && !newFolderName.trim()) ||
                (type === 'latex' && !mainFile.trim())
              }
            >
              {submitting ? 'Creating…' : `Create ${definition.label} project`}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
