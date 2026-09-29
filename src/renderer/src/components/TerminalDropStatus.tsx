import { useEffect, useState } from 'react'
import { ClipboardCopy, Upload, X } from 'lucide-react'
import { droppedPathsText, type TerminalDropProgress } from '@shared/terminalDrops'

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

export function TerminalDropStatus() {
  const [transfers, setTransfers] = useState<TerminalDropProgress[]>([])
  const [dismissed, setDismissed] = useState<string[]>([])
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState('')
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
  const label = uploading ? 'Uploading' : event.state === 'completed' ? 'Uploaded' : 'Upload failed'
  return (
    <div className={`terminal-drop-status ${event.state}`} title={`${event.target}\n${event.fileName}\n${event.error ?? 'Uploaded paths can be copied and pasted into your prompt.'}`}>
      <Upload size={12} />
      <span className="terminal-drop-label" role="status">{label} · {event.fileName || event.target}{event.error ? ` · ${event.error}` : ''}</span>
      {uploading ? <>
        <progress aria-label="File upload progress" max={event.totalBytes || 1} value={event.transferredBytes} />
        <span>{percent}% · {bytes(event.transferredBytes)}/{bytes(event.totalBytes)} · {event.completedFiles}/{event.totalFiles} files</span>
      </> : <span>{event.completedFiles}/{event.totalFiles} files</span>}
      {visible.length > 1 && <span title="Other transfers">+{visible.length - 1}</span>}
      {!!event.paths.length && <button aria-label="Copy uploaded file paths" onClick={() => {
        void window.projectConsole.system.copyText(droppedPathsText(event.paths))
          .then(() => { setCopied(`${event.id}:${event.paths.length}`); setCopyError('') })
          .catch((error) => setCopyError(String(error)))
      }}><ClipboardCopy size={12} />{copied === `${event.id}:${event.paths.length}` ? 'Copied' : 'Copy paths'}</button>}
      {!uploading && <button aria-label="Dismiss upload status" onClick={() => setDismissed((current) => [...current.slice(-19), event.id])}><X size={12} /></button>}
      {copyError && <span role="alert">{copyError}</span>}
    </div>
  )
}
