import { useEffect, useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ClipboardCopy, Upload, X } from 'lucide-react'
import { droppedPathsText, type TerminalDropProgress } from '@shared/terminalDrops'

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function TerminalDropStatus() {
  const [copyTarget, setCopyTarget] = useState<HTMLElement | null>(null)
  const [transfers, setTransfers] = useState<TerminalDropProgress[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState('')
  // Keep one transfer subscription while rendering its action beside the YOLO pill.
  useLayoutEffect(() => {
    setCopyTarget(document.getElementById('status-transfer-actions'))
  }, [])
  useEffect(() => {
    const api = window.projectConsole.terminalDrops
    if (!api) return
    let mounted = true
    const receive = (event: TerminalDropProgress) => {
      if (!mounted) return
      setTransfers((current) => {
        const previous = current.find((item) => item.id === event.id)
        if (previous && previous.updatedAt > event.updatedAt) return current
        return previous ? current.map((item) => item.id === event.id ? event : item) : [...current, event].slice(-10)
      })
    }
    const off = api.onProgress(receive)
    void api.list().then((items) => items.forEach(receive)).catch(() => {})
    return () => { mounted = false; off() }
  }, [])
  const visible = transfers.filter((item) => !dismissed.includes(item.id))
  const event = visible.find((item) => item.state === 'uploading') ?? visible.at(-1)
  if (!event) return null
  const uploading = event.state === 'uploading'
  const percent = event.totalBytes ? Math.min(100, Math.floor(event.transferredBytes * 100 / event.totalBytes)) : 0
  const label = event.operation === 'copy'
    ? uploading ? 'Copying' : event.state === 'completed' ? 'Copied' : 'Copy failed'
    : uploading ? 'Uploading' : event.state === 'completed' ? 'Uploaded' : 'Upload failed'
  return (
    <>
      {copyTarget && !!event.paths.length && createPortal(
        <button className="terminal-drop-copy" aria-label="Copy transferred file paths"
          title={`Copy transferred file paths from ${event.target}`} onClick={() => {
            void window.projectConsole.system.copyText(droppedPathsText(event.paths))
              .then(() => { setCopied(`${event.id}:${event.paths.length}`); setCopyError('') })
              .catch((error) => setCopyError(String(error)))
          }}><ClipboardCopy size={12} />{copied === `${event.id}:${event.paths.length}` ? 'Copied' : 'Copy paths'}</button>,
        copyTarget
      )}
      <div className={`terminal-drop-status ${event.state}`} title={`${event.target}\n${event.fileName}\n${event.error ?? 'Transferred file paths can be copied.'}`}>
        <Upload size={12} />
        <span className="terminal-drop-label" role="status">{label} · {event.fileName || event.target}{event.error ? ` · ${event.error}` : ''}</span>
        {uploading ? <>
          <progress aria-label="File transfer progress" max={event.totalBytes || 1} value={event.transferredBytes} />
          <span>{percent}% · {bytes(event.transferredBytes)}/{bytes(event.totalBytes)} · {event.completedFiles}/{event.totalFiles} files</span>
        </> : <span>{event.completedFiles}/{event.totalFiles} files</span>}
        {visible.length > 1 && <span title="Other transfers">+{visible.length - 1}</span>}
        {!uploading && <button aria-label="Dismiss transfer status" onClick={() => setDismissed((current) => [...current.slice(-19), event.id])}><X size={12} /></button>}
        {copyError && <span role="alert">{copyError}</span>}
      </div>
    </>
  )
}
