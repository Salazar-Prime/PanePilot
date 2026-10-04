import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { GitFork, X } from 'lucide-react'
import type { CodexSubagent, CodexSubagentSnapshot } from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'
import '../subagents.css'

const stateLabels = { working: 'Working', finished: 'Finished', stopped: 'Stopped', unknown: 'Status unavailable' }

const AgentWindow = memo(function AgentWindow({ agent }: { agent: CodexSubagent }) {
  const outputRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const [follow, setFollow] = useState(true)
  useLayoutEffect(() => {
    const node = outputRef.current
    if (node && following.current) node.scrollTop = node.scrollHeight
  }, [agent.output])
  return (
    <article className="subagent-window" aria-label={`${agent.name} output`}>
      <header className="subagent-window-heading">
        <div>
          <strong>{agent.name}</strong>
          <small title={agent.path}>{agent.path || 'Codex sub-agent'}</small>
        </div>
        <span className={`subagent-state ${agent.state}`} title="Latest status recorded in this agent’s archive"><i />{stateLabels[agent.state]}</span>
      </header>
      <div className="subagent-output" ref={outputRef} tabIndex={0} aria-label={`${agent.name} transcript`}
        onScroll={(event) => {
          const node = event.currentTarget
          following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
          setFollow(following.current)
        }}>
        {agent.truncated && <p className="subagent-output-note">Recent output only · older or long entries shortened</p>}
        {agent.output.length === 0 && <p className="subagent-output-note">Waiting for this agent to write output…</p>}
        {agent.output.map((item, index) => (
          <div className={`subagent-entry ${item.kind}`} key={index}>
            <span>{item.kind === 'tool' ? 'Tool call' : item.kind === 'result' ? 'Tool output' : 'Agent'}</span>
            <pre>{item.text}</pre>
          </div>
        ))}
      </div>
      {!follow && <button className="subagent-follow" onClick={() => {
        following.current = true
        setFollow(true)
        if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight
      }}>Jump to latest</button>}
    </article>
  )
}, (previous, next) => {
  const a = previous.agent, b = next.agent
  return a.id === b.id && a.name === b.name && a.path === b.path && a.state === b.state &&
    a.truncated === b.truncated && a.output.length === b.output.length &&
    a.output.every((entry, index) => entry.kind === b.output[index].kind && entry.text === b.output[index].text)
})

export function SubagentOverlay({ sessionId, sessionName, projectName, onClose }: {
  sessionId: string; sessionName: string; projectName: string; onClose(): void
}) {
  const [snapshot, setSnapshot] = useState<CodexSubagentSnapshot | null>(null)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  useModalEscape(onClose)

  useEffect(() => {
    const previous = document.activeElement
    closeRef.current?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])

  useEffect(() => {
    let disposed = false
    let busy = false
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      if (disposed || busy || document.hidden) return
      busy = true
      try {
        const next = await window.projectConsole.terminals.subagents(sessionId)
        if (!disposed) {
          // New output must not reorder windows while the user is reading them.
          next.agents.sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name, undefined, { numeric: true }) || a.id.localeCompare(b.id))
          setSnapshot(next)
          setError('')
        }
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        busy = false
        if (!disposed && !document.hidden) timer = setTimeout(poll, 3_000)
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void poll()
    }
    void poll()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [sessionId])

  return createPortal(
    <div className="subagent-glass" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="subagent-observatory" role="dialog" aria-modal="true" aria-labelledby="subagent-title"
        ref={dialogRef} onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])
          const first = elements[0], last = elements.at(-1)
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
        }}>
        <header className="subagent-heading">
          <div className="subagent-title"><GitFork size={24} /><div>
            <h2 id="subagent-title">Sub-agents</h2>
            <p>{projectName} <span> / </span> {sessionName}</p>
          </div></div>
          <div className="subagent-heading-actions">
            <small>{snapshot ? `${snapshot.agents.length} ${snapshot.agents.length === 1 ? 'agent' : 'agents'}` : 'Reading archives…'}</small>
            <button className="icon-button" aria-label="Close sub-agents" onClick={onClose} ref={closeRef}><X size={19} /></button>
          </div>
        </header>
        {error && <div className="subagent-error" role="status">{error}{snapshot && ' Showing the last successful snapshot.'}</div>}
        {snapshot?.limited && <p className="subagent-notice">Showing up to 24 recent agents. The archive scan or output limit was reached.</p>}
        {snapshot && snapshot.agents.length === 0 && !error && <div className="subagent-empty">
          <GitFork size={36} />
          <h3>{snapshot.rootFound ? 'No sub-agents yet' : 'Waiting for the Codex archive'}</h3>
          <p>{snapshot.rootFound ? 'When this Codex terminal delegates work, each agent’s saved output will appear here.' : 'The exact thread archive is not available on this project’s machine yet.'}</p>
        </div>}
        {!snapshot && !error && <div className="subagent-empty"><p>Finding agents belonging to this terminal…</p></div>}
        <div className="subagent-grid">{snapshot?.agents.map((agent) => <AgentWindow key={agent.id} agent={agent} />)}</div>
        <footer className="subagent-footer">Read-only · saved messages and tool output refresh every 3 seconds · Escape to close</footer>
      </section>
    </div>, document.body
  )
}
