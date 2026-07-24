import { useCallback, useEffect, useState } from 'react'
import {
  CircleStop,
  LoaderCircle,
  Network,
  Play,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import type { Connection, ConnectionTestResult, PortForward } from '@shared/types'

interface Props {
  connection: Connection
  onClose(): void
}

export function PortForwardDialog({ connection, onClose }: Props) {
  const [forwards, setForwards] = useState<PortForward[]>([])
  const [name, setName] = useState('')
  const [localPort, setLocalPort] = useState('')
  const [remoteHost, setRemoteHost] = useState('127.0.0.1')
  const [remotePort, setRemotePort] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null)
  const [testing, setTesting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setForwards(await window.projectConsole.portForwards.list(connection.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [connection.id])

  useEffect(() => {
    void refresh()
    return window.projectConsole.portForwards.onChanged(() => void refresh())
  }, [refresh])

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.projectConsole.connections.test(connection.id))
    } catch (caught) {
      setTestResult({
        ok: false,
        message: caught instanceof Error ? caught.message : String(caught),
        latencyMs: 0
      })
    } finally {
      setTesting(false)
    }
  }

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await window.projectConsole.portForwards.create({
        connectionId: connection.id,
        name,
        localPort: Number(localPort),
        remoteHost,
        remotePort: Number(remotePort)
      })
      setName('')
      setLocalPort('')
      setRemotePort('')
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function toggle(forward: PortForward) {
    setError('')
    try {
      if (forward.state === 'running' || forward.state === 'starting') {
        await window.projectConsole.portForwards.stop(forward.id)
      } else {
        await window.projectConsole.portForwards.start(forward.id)
      }
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      await refresh()
    }
  }

  async function remove(forward: PortForward) {
    if (!window.confirm(`Delete the saved port forward “${forward.name}”?`)) return
    try {
      await window.projectConsole.portForwards.delete(forward.id)
      await refresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal port-forward-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="port-forward-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">SSH CONNECTION · {connection.name}</span>
            <h2 id="port-forward-title">Port forwarding</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>

        <div className="connection-test-row">
          <Network size={16} />
          <div>
            <strong>{connection.sshAlias}</strong>
            <span>
              {testResult
                ? `${testResult.message}${testResult.ok ? ` (${testResult.latencyMs} ms)` : ''}`
                : 'Use SSH key or agent authentication.'}
            </span>
          </div>
          <button
            className="secondary-button"
            onClick={() => void testConnection()}
            disabled={testing}
          >
            <RefreshCw size={13} className={testing ? 'spin' : ''} />
            Test
          </button>
        </div>

        <div className="port-forward-list">
          {forwards.length ? (
            forwards.map((forward) => (
              <div className="port-forward-row" key={forward.id}>
                <span className={`forward-state ${forward.state}`} />
                <div>
                  <strong>{forward.name}</strong>
                  <span>
                    127.0.0.1:{forward.localPort} → {forward.remoteHost}:{forward.remotePort}
                  </span>
                  {forward.error && <small>{forward.error}</small>}
                </div>
                <button
                  className="icon-button"
                  onClick={() => void toggle(forward)}
                  title={
                    forward.state === 'running' || forward.state === 'starting'
                      ? 'Stop forward'
                      : 'Start forward'
                  }
                >
                  {forward.state === 'starting' ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : forward.state === 'running' ? (
                    <CircleStop size={15} />
                  ) : (
                    <Play size={15} />
                  )}
                </button>
                <button
                  className="icon-button danger-text"
                  disabled={forward.state === 'running' || forward.state === 'starting'}
                  onClick={() => void remove(forward)}
                  title="Delete saved forward"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          ) : (
            <p className="port-forward-empty">No saved forwards for this SSH connection.</p>
          )}
        </div>

        <form className="port-forward-form" onSubmit={create}>
          <span className="form-section-label">ADD LOCAL FORWARD</span>
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Development database"
            />
          </label>
          <div className="port-fields">
            <label className="field">
              <span>Local port</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={localPort}
                onChange={(event) => setLocalPort(event.target.value)}
                placeholder="5433"
              />
            </label>
            <label className="field remote-host-field">
              <span>Remote host</span>
              <input
                value={remoteHost}
                onChange={(event) => setRemoteHost(event.target.value)}
                placeholder="127.0.0.1"
              />
            </label>
            <label className="field">
              <span>Remote port</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={remotePort}
                onChange={(event) => setRemotePort(event.target.value)}
                placeholder="5432"
              />
            </label>
          </div>
          <p className="port-forward-note">
            PanePilot binds forwards to 127.0.0.1 only. They stop when PanePilot exits.
          </p>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Close
            </button>
            <button
              className="primary-button"
              disabled={busy || !name.trim() || !localPort || !remoteHost || !remotePort}
            >
              <Plus size={14} /> {busy ? 'Starting…' : 'Add and start'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
