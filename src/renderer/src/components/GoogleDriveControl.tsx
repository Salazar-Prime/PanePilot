import { useEffect, useState } from 'react'
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  FolderInput,
  LoaderCircle,
  RefreshCw,
  SquareTerminal,
  Unplug,
  X
} from 'lucide-react'
import type { GoogleDriveStatus, Project } from '@shared/types'

interface Props {
  project: Project
  openRequest?: { projectId: string; nonce: number } | null
}

export function GoogleDriveControl({ project, openRequest = null }: Props) {
  const [status, setStatus] = useState<GoogleDriveStatus | null>(null)
  const [remotes, setRemotes] = useState<string[]>([])
  const [remoteName, setRemoteName] = useState('')
  const [folderPath, setFolderPath] = useState('')
  const [open, setOpen] = useState(false)
  const [editingConnection, setEditingConnection] = useState(false)
  const [working, setWorking] = useState(false)
  const [loadingRemotes, setLoadingRemotes] = useState(false)
  const [copied, setCopied] = useState('')
  const [error, setError] = useState('')

  async function loadStatus() {
    const next = await window.projectConsole.googleDrive.status(project.id)
    setStatus(next)
    setRemoteName(next.remoteName ?? '')
    setFolderPath(next.folderPath ?? '')
    return next
  }

  async function refreshRemotes(nextStatus = status) {
    if (!nextStatus?.available) return
    setLoadingRemotes(true)
    setError('')
    try {
      const next = await window.projectConsole.googleDrive.listRemotes()
      setRemotes(next)
      setRemoteName((current) => current || next[0] || '')
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setLoadingRemotes(false)
    }
  }

  useEffect(() => {
    let active = true
    setStatus(null)
    setError('')
    setEditingConnection(false)
    void window.projectConsole.googleDrive
      .status(project.id)
      .then((next) => {
        if (!active) return
        setStatus(next)
        setRemoteName(next.remoteName ?? '')
        setFolderPath(next.folderPath ?? '')
        if (next.available) void refreshRemotes(next)
      })
      .catch((caught) => {
        if (active) setError(messageFor(caught))
      })
    return () => {
      active = false
    }
  }, [project.id])

  useEffect(() => {
    if (openRequest?.projectId === project.id) setOpen(true)
  }, [openRequest?.nonce, openRequest?.projectId, project.id])

  async function connect() {
    setWorking(true)
    setError('')
    try {
      const next = await window.projectConsole.googleDrive.connect({
        projectId: project.id,
        remoteName,
        folderPath
      })
      setStatus(next)
      setRemoteName(next.remoteName ?? '')
      setFolderPath(next.folderPath ?? '')
      setEditingConnection(false)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setWorking(false)
    }
  }

  async function checkRclone() {
    setWorking(true)
    setError('')
    try {
      const next = await loadStatus()
      if (next.available) await refreshRemotes(next)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setWorking(false)
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        `Remove the Drive destination from ${project.name}? Files already uploaded to Drive will stay there.`
      )
    ) {
      return
    }
    setWorking(true)
    setError('')
    try {
      await window.projectConsole.googleDrive.disconnect(project.id)
      await loadStatus()
      setEditingConnection(false)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setWorking(false)
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      window.setTimeout(() => setCopied(''), 1600)
    } catch (caught) {
      setError(messageFor(caught))
    }
  }

  const showSetup = !status?.connected || editingConnection

  return (
    <>
      <button
        className={`secondary-button header-button drive-header-button ${
          status?.connected ? 'connected' : ''
        }`}
        onClick={() => setOpen(true)}
        title={
          status?.connected
            ? `Google Drive destination: ${status.destination}`
            : 'Connect an rclone Google Drive destination to this project'
        }
      >
        <Cloud size={15} />
        {status?.connected ? 'Drive' : 'Connect Drive'}
        {status?.connected && <i aria-label="Connected" />}
      </button>

      {open && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => !working && setOpen(false)}
        >
          <section
            className="modal drive-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="drive-dialog-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <span className="eyebrow">PROJECT DESTINATION</span>
                <h2 id="drive-dialog-title">Google Drive via rclone</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                disabled={working}
              >
                <X size={17} />
              </button>
            </div>

            {status?.connected && !editingConnection && (
              <>
                <div className="drive-account-card">
                  <div className="drive-account-icon">
                    <Check size={17} />
                  </div>
                  <div>
                    <span>DESTINATION FOR {project.name.toLocaleUpperCase()}</span>
                    <strong>{status.destination}</strong>
                    <small>
                      rclone remote “{status.remoteName}” · uploads keep their
                      project-relative path
                    </small>
                  </div>
                </div>
                <p className="drive-explainer">
                  The Monaco upload button sends only the saved file currently open.
                  PanePilot returns its private Drive link and records that link in
                  this project’s activity.
                </p>
                {!status.available && (
                  <p className="form-error">
                    This destination is saved, but rclone is not currently installed
                    or visible to PanePilot.
                  </p>
                )}
                {error && <p className="form-error">{error}</p>}
                <div className="drive-link-row">
                  <button
                    className="secondary-button"
                    onClick={() =>
                      status.folderUrl && void copy(status.folderUrl, 'folder')
                    }
                    disabled={!status.folderUrl}
                  >
                    <Copy size={13} />
                    {copied === 'folder' ? 'Copied' : 'Copy folder link'}
                  </button>
                  <button
                    className="primary-button"
                    onClick={() =>
                      void window.projectConsole.googleDrive.openFolder(project.id)
                    }
                    disabled={!status.folderUrl}
                  >
                    <ExternalLink size={14} /> Open folder
                  </button>
                </div>
                <div className="modal-actions drive-modal-actions">
                  <button
                    className="secondary-button disconnect-drive-button"
                    onClick={() => void disconnect()}
                    disabled={working}
                  >
                    <Unplug size={14} /> Remove destination
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => setEditingConnection(true)}
                    disabled={working || !status.available}
                  >
                    <FolderInput size={14} /> Change account or folder
                  </button>
                </div>
              </>
            )}

            {showSetup && (
              <>
                <div className="drive-setup-intro">
                  <div className="drive-setup-mark">
                    <SquareTerminal size={21} />
                  </div>
                  <div>
                    <strong>One rclone remote per Google account</strong>
                    <p>
                      rclone owns the OAuth credentials. PanePilot stores only the
                      selected remote name, folder path, and returned Drive IDs.
                    </p>
                  </div>
                </div>

                {!status?.available ? (
                  <ol className="drive-setup-steps">
                    <li>
                      Install rclone with <b>brew install rclone</b>.
                    </li>
                    <li>
                      Run <b>rclone config</b> in a terminal and create a named Google
                      Drive remote for each account.
                    </li>
                    <li>
                      Return here, check again, then choose a remote and existing
                      folder.
                    </li>
                  </ol>
                ) : (
                  <>
                    <div className="drive-destination-form">
                      <label>
                        <span>RCLONE REMOTE / GOOGLE ACCOUNT</span>
                        <div className="drive-input-row">
                          <input
                            list="google-drive-remotes"
                            value={remoteName}
                            onChange={(event) => setRemoteName(event.target.value)}
                            placeholder="personal-drive"
                            disabled={working}
                          />
                          <datalist id="google-drive-remotes">
                            {remotes.map((remote) => (
                              <option key={remote} value={remote} />
                            ))}
                          </datalist>
                          <button
                            className="icon-button"
                            onClick={() => void refreshRemotes()}
                            title="Refresh rclone remotes"
                            aria-label="Refresh rclone remotes"
                            disabled={working || loadingRemotes}
                          >
                            <RefreshCw
                              className={loadingRemotes ? 'spin' : ''}
                              size={14}
                            />
                          </button>
                        </div>
                      </label>
                      <label>
                        <span>EXISTING FOLDER IN THAT DRIVE</span>
                        <input
                          value={folderPath}
                          onChange={(event) => setFolderPath(event.target.value)}
                          placeholder="PanePilot/My project"
                          disabled={working}
                        />
                        <small>
                          Leave empty for My Drive. Files retain paths such as{' '}
                          <code>src/main.ts</code> below this folder.
                        </small>
                      </label>
                    </div>
                    {remotes.length === 0 && !loadingRemotes && (
                      <p className="drive-inline-note">
                        No rclone remotes found. Run <b>rclone config</b>, then refresh.
                      </p>
                    )}
                  </>
                )}

                <div className="drive-cli-links">
                  <button
                    className="drive-cloud-link"
                    onClick={() => void copy('rclone config', 'command')}
                  >
                    <Copy size={13} />
                    {copied === 'command' ? 'Command copied' : 'Copy rclone config'}
                  </button>
                  <button
                    className="drive-cloud-link"
                    onClick={() =>
                      void window.projectConsole.system.openExternal(
                        'https://rclone.org/drive/'
                      )
                    }
                  >
                    <ExternalLink size={13} /> rclone Drive setup guide
                  </button>
                </div>
                {error && <p className="form-error">{error}</p>}
                <div className="modal-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      if (status?.connected) {
                        setRemoteName(status.remoteName ?? '')
                        setFolderPath(status.folderPath ?? '')
                        setEditingConnection(false)
                      } else {
                        setOpen(false)
                      }
                    }}
                    disabled={working}
                  >
                    {status?.connected ? 'Cancel' : 'Not now'}
                  </button>
                  <button
                    className="primary-button"
                    onClick={() =>
                      status?.available ? void connect() : void checkRclone()
                    }
                    disabled={
                      working || (status?.available === true && !remoteName.trim())
                    }
                  >
                    {working ? (
                      <LoaderCircle className="spin" size={14} />
                    ) : status?.available ? (
                      <FolderInput size={14} />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                    {working
                      ? status?.available
                        ? 'Validating folder…'
                        : 'Checking…'
                      : status?.available
                        ? 'Attach this folder'
                        : 'Check for rclone'}
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </>
  )
}

function messageFor(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}
