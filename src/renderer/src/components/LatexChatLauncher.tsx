import { useState } from 'react'
import {
  Bot,
  MessageCircleQuestion,
  PencilLine,
  ShieldAlert,
  Sparkles,
  X
} from 'lucide-react'
import type {
  ConversationProvider,
  LatexChatMode,
  LatexChatScope,
  LatexSection,
  StartLatexChatInput
} from '@shared/types'
import { useModalEscape } from '../lib/modalEscape'
import {
  latexSectionKindLabel,
  latexSectionOptionLabel
} from '../lib/latexSectionLabels'

interface Props {
  projectId: string
  sections: LatexSection[]
  initialSectionId: string | null
  onClose(): void
  onStart(input: StartLatexChatInput): Promise<void>
}

export function LatexChatLauncher({
  projectId,
  sections,
  initialSectionId,
  onClose,
  onStart
}: Props) {
  const initialSection =
    sections.find((section) => section.id === initialSectionId) ?? null
  const [provider, setProvider] = useState<ConversationProvider>('codex')
  const [mode, setMode] = useState<LatexChatMode>('ask')
  const [scope, setScope] = useState<LatexChatScope>(
    initialSection ? 'section' : 'project'
  )
  const [sectionId, setSectionId] = useState(
    initialSection?.id ?? sections[0]?.id ?? ''
  )
  const [name, setName] = useState('')
  const [dangerousMode, setDangerousMode] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  useModalEscape(onClose, true, submitting)
  const selectedSection = sections.find((section) => section.id === sectionId) ?? null
  const outlineBaseLevel = sections.length
    ? Math.min(...sections.map((section) => section.level))
    : 2
  const scopeKind =
    scope === 'project' || !selectedSection
      ? 'Project'
      : latexSectionKindLabel(selectedSection.level)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await onStart({
        projectId,
        name: name.trim() || undefined,
        provider,
        mode,
        scope,
        sectionId: scope === 'section' ? sectionId : undefined,
        dangerousMode
      })
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
        className="modal latex-chat-launcher"
        role="dialog"
        aria-modal="true"
        aria-labelledby="latex-chat-launcher-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-heading">
          <div>
            <span className="eyebrow">ATTACH A WRITING AGENT</span>
            <h2 id="latex-chat-launcher-title">Start a LaTeX chat</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="profile-grid">
            <button
              type="button"
              className={`profile-card ${provider === 'codex' ? 'selected' : ''}`}
              onClick={() => setProvider('codex')}
            >
              <Sparkles size={20} />
              <strong>Codex</strong>
              <span>OpenAI agent in persistent tmux</span>
            </button>
            <button
              type="button"
              className={`profile-card ${provider === 'claude' ? 'selected' : ''}`}
              onClick={() => setProvider('claude')}
            >
              <Bot size={20} />
              <strong>Claude Code</strong>
              <span>Anthropic agent in persistent tmux</span>
            </button>
          </div>

          <div className="latex-mode-grid" aria-label="Chat mode">
            <button
              type="button"
              className={mode === 'ask' ? 'selected' : ''}
              onClick={() => setMode('ask')}
            >
              <MessageCircleQuestion size={18} />
              <span>
                <strong>Ask</strong>
                <small>Read and advise without changing files</small>
              </span>
            </button>
            <button
              type="button"
              className={mode === 'edit' ? 'selected edit' : 'edit'}
              onClick={() => setMode('edit')}
            >
              <PencilLine size={18} />
              <span>
                <strong>Edit</strong>
                <small>Let the agent update the attached scope</small>
              </span>
            </button>
          </div>

          <label className="field latex-scope-field">
            <span>Attach scope</span>
            <select
              value={scope === 'project' ? 'project' : sectionId}
              onChange={(event) => {
                if (event.target.value === 'project') {
                  setScope('project')
                } else {
                  setScope('section')
                  setSectionId(event.target.value)
                }
              }}
            >
              <option value="project">PROJECT — Whole manuscript</option>
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {latexSectionOptionLabel(section, outlineBaseLevel)}
                </option>
              ))}
            </select>
          </label>

          <div
            className={`latex-scope-note ${
              scope === 'project' || !selectedSection
                ? 'project'
                : `level-${selectedSection.level}`
            }`}
          >
            <span className="latex-scope-kind">{scopeKind}</span>
            <span className="latex-scope-note-copy">
              <strong>
                {scope === 'project' || !selectedSection
                  ? 'Whole manuscript'
                  : selectedSection.title}
              </strong>
              <small>
                {scope === 'project' || !selectedSection
                  ? 'Main file, included sources, and the context folder'
                  : `${selectedSection.sourceFile} · lines ${selectedSection.startLine}–${selectedSection.endLine}${
                      mode === 'edit' ? ' · edits stay within this range' : ''
                    }`}
              </small>
            </span>
          </div>

          <label className="field">
            <span>Chat / tmux name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional — PanePilot will choose a unique name"
            />
          </label>

          <label className={`danger-option ${dangerousMode ? 'enabled' : ''}`}>
            <input
              type="checkbox"
              checked={dangerousMode}
              onChange={(event) => setDangerousMode(event.target.checked)}
            />
            <ShieldAlert size={19} />
            <span>
              <strong>Disable permission checks</strong>
              <small>Only for isolated or disposable environments</small>
            </span>
          </label>

          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={onClose}>
              Cancel
            </button>
            <button
              className="primary-button"
              disabled={submitting || (scope === 'section' && !sectionId)}
            >
              {submitting ? 'Starting…' : 'Start chat'}
            </button>
          </div>
        </form>
      </section>
    </div>
  )
}
