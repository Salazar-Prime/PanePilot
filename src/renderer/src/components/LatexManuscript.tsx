import Editor, { loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenText,
  Check,
  ChevronRight,
  CircleDotDashed,
  FileText,
  FolderSearch,
  MessageSquareText,
  RefreshCw,
  Save,
  Send,
  Sparkles,
  X
} from 'lucide-react'
import type {
  LatexChangeSet,
  LatexSection,
  LatexSourceSelection,
  LatexWorkspace,
  Project,
  TerminalSession
} from '@shared/types'
import { latexMonarchLanguage } from '../lib/latexLanguage'
import { addShowInFinderAction } from '../lib/monacoFinderAction'
import { ManagedTerminal } from './ManagedTerminal'
import { StatusDot } from './StatusDot'

loader.config({ monaco })
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker()
    if (['css', 'scss', 'less'].includes(label)) return new cssWorker()
    if (['html', 'handlebars', 'razor'].includes(label)) return new htmlWorker()
    if (['typescript', 'javascript'].includes(label)) return new tsWorker()
    return new editorWorker()
  }
}

if (!monaco.languages.getLanguages().some((language) => language.id === 'latex')) {
  monaco.languages.register({ id: 'latex', extensions: ['.tex'] })
  monaco.languages.setMonarchTokensProvider('latex', latexMonarchLanguage)
}

monaco.editor.defineTheme('panepilot-latex', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '68717E', fontStyle: 'italic' },
    { token: 'keyword', foreground: '9AA9FF', fontStyle: 'bold' },
    { token: 'type.identifier', foreground: '7CCBB2' },
    { token: 'delimiter', foreground: 'C6A96A' },
    { token: 'operator', foreground: 'D48E9B' }
  ],
  colors: {
    'editor.background': '#0A0C11',
    'editor.foreground': '#D7DAE2',
    'editorLineNumber.foreground': '#434A57',
    'editorLineNumber.activeForeground': '#929BAA',
    'editorCursor.foreground': '#A8B5FF',
    'editor.selectionBackground': '#5368C444',
    'editor.lineHighlightBackground': '#12151D'
  }
})

interface Props {
  project: Project
  workspace: LatexWorkspace
  inlineSession: TerminalSession | null
  selectedSectionId: string | null
  chatCounts: Map<string, number>
  changes: LatexChangeSet | null
  onSelectSection(id: string | null): void
  onOpenContext(): void
  onClearChanges(): Promise<void>
  onWorkspaceRefresh(): Promise<void>
  onInlineEdit(
    selection: LatexSourceSelection,
    instruction: string
  ): Promise<void>
}

interface InlineEditState {
  selection: LatexSourceSelection
  top: number
  left: number
  above: boolean
  expanded: boolean
  instruction: string
  error: string
}

export function LatexManuscript({
  project,
  workspace,
  inlineSession,
  selectedSectionId,
  chatCounts,
  changes,
  onSelectSection,
  onOpenContext,
  onClearChanges,
  onWorkspaceRefresh,
  onInlineEdit
}: Props) {
  const [reviewPath, setReviewPath] = useState<string | null>(null)
  const [path, setPath] = useState(workspace.details.mainFile)
  const [savedContent, setSavedContent] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sendingInlineEdit, setSendingInlineEdit] = useState(false)
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null)
  const [showInlineChat, setShowInlineChat] = useState(false)
  const [error, setError] = useState('')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const finderActionRef = useRef<{ dispose(): void } | null>(null)
  const activeFinderPathRef = useRef(path)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const viewZoneIdsRef = useRef<string[]>([])
  const inlineEditDisposablesRef = useRef<{ dispose(): void }[]>([])
  const inlinePromptRef = useRef<HTMLTextAreaElement | null>(null)
  const dirty = draft !== savedContent
  activeFinderPathRef.current = path
  const selectedSection =
    workspace.sections.find((section) => section.id === selectedSectionId) ?? null
  const desiredPath =
    reviewPath ?? selectedSection?.sourceFile ?? workspace.details.mainFile
  const fileChanges = changes?.files.find((file) => file.path === path) ?? null
  const totalChanges =
    changes?.files.reduce(
      (total, file) => total + file.additions + file.modifications + file.deletions,
      0
    ) ?? 0
  const changeSignature =
    changes?.files
      .map((file) =>
        [
          file.path,
          ...file.highlights.map(
            (change) =>
              `${change.kind}:${change.startLine}:${change.startColumn}:${change.originalText}:${change.currentText}`
          )
        ].join('\u0000')
      )
      .join('\u0001') ?? ''

  async function load(nextPath: string, revealSection?: LatexSection | null) {
    setLoading(true)
    setError('')
    try {
      const preview = await window.projectConsole.files.preview(project.id, nextPath)
      if (preview.binary || preview.truncated) {
        throw new Error('LaTeX source files must be UTF-8 text no larger than 1 MB.')
      }
      setPath(nextPath)
      setSavedContent(preview.content)
      setDraft(preview.content)
      requestAnimationFrame(() => {
        if (revealSection && revealSection.sourceFile === nextPath) {
          editorRef.current?.revealLineInCenter(revealSection.startLine)
          editorRef.current?.setPosition({ lineNumber: revealSection.startLine, column: 1 })
        }
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (desiredPath === path && savedContent) {
      if (selectedSection) {
        editorRef.current?.revealLineInCenter(selectedSection.startLine)
      }
      return
    }
    void load(desiredPath, selectedSection)
  }, [project.id, desiredPath])

  useEffect(
    () => () => {
      finderActionRef.current?.dispose()
      for (const disposable of inlineEditDisposablesRef.current) {
        disposable.dispose()
      }
      inlineEditDisposablesRef.current = []
    },
    []
  )

  useEffect(() => {
    setInlineEdit(null)
    setShowInlineChat(false)
  }, [project.id])

  useEffect(() => {
    const changed = changes?.files.some((file) => file.path === path)
    if (!changed || dirty) return
    void load(path, selectedSection)
  }, [changes?.capturedAt, changeSignature])

  useEffect(() => {
    function saveShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault()
        if (dirty && !saving) void save()
      }
    }
    window.addEventListener('keydown', saveShortcut)
    return () => window.removeEventListener('keydown', saveShortcut)
  }, [dirty, saving, draft, path])

  useEffect(() => {
    applyDecorations()
  }, [fileChanges, draft])

  useEffect(() => {
    if (!showInlineChat) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return
      const target = event.target
      if (
        target instanceof Element &&
        target.closest('.latex-inline-chat-terminal')
      ) {
        return
      }
      setShowInlineChat(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showInlineChat])

  async function save(): Promise<boolean> {
    setSaving(true)
    setError('')
    try {
      await window.projectConsole.files.save(project.id, path, draft)
      setSavedContent(draft)
      await onWorkspaceRefresh()
      return true
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      return false
    } finally {
      setSaving(false)
    }
  }

  function canNavigate(): boolean {
    return !dirty || window.confirm('Discard your unsaved LaTeX changes?')
  }

  function selectSection(section: LatexSection | null) {
    if (!canNavigate()) return
    setReviewPath(null)
    onSelectSection(section?.id ?? null)
    const nextPath = section?.sourceFile ?? workspace.details.mainFile
    if (nextPath === path) {
      setDraft(savedContent)
      if (section) editorRef.current?.revealLineInCenter(section.startLine)
    }
  }

  function reviewFile(nextPath: string) {
    if (!canNavigate()) return
    setReviewPath(nextPath)
    setDraft(savedContent)
  }

  async function showActiveFileInFinder() {
    setError('')
    try {
      await window.projectConsole.files.showInFolder(
        project.id,
        activeFinderPathRef.current
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    finderActionRef.current?.dispose()
    for (const disposable of inlineEditDisposablesRef.current) {
      disposable.dispose()
    }
    inlineEditDisposablesRef.current = []
    if (project.connectionId === 'local') {
      finderActionRef.current = addShowInFinderAction(
        editor,
        showActiveFileInFinder
      )
    }
    applyDecorations()
    if (selectedSection && selectedSection.sourceFile === path) {
      editor.revealLineInCenter(selectedSection.startLine)
    }

    function inlinePosition(
      selection: LatexSourceSelection,
      expanded: boolean
    ): Pick<InlineEditState, 'top' | 'left' | 'above'> | null {
      const visible = editor.getScrolledVisiblePosition({
        lineNumber: selection.endLine,
        column: selection.endColumn
      })
      if (!visible) return null
      const layout = editor.getLayoutInfo()
      const panelWidth = expanded ? 334 : 142
      const panelHeight = expanded ? 184 : 30
      const below = visible.top + visible.height + 7
      const above = below + panelHeight > layout.height - 8
      return {
        top: above ? Math.max(8, visible.top - panelHeight - 7) : below,
        left: Math.max(12, Math.min(visible.left, layout.width - panelWidth - 12)),
        above
      }
    }

    function captureSelection(expanded = false) {
      const model = editor.getModel()
      const range = editor.getSelection()
      if (!model || !range || range.isEmpty()) {
        setInlineEdit(null)
        return
      }
      const selection: LatexSourceSelection = {
        path: activeFinderPathRef.current,
        startLine: range.startLineNumber,
        startColumn: range.startColumn,
        endLine: range.endLineNumber,
        endColumn: range.endColumn,
        text: model.getValueInRange(range)
      }
      const position = inlinePosition(selection, expanded)
      if (!position) return
      setInlineEdit({
        selection,
        ...position,
        expanded,
        instruction: '',
        error:
          selection.text.length > 20_000
            ? 'Select no more than 20,000 characters.'
            : ''
      })
      if (expanded) {
        window.requestAnimationFrame(() => inlinePromptRef.current?.focus())
      }
    }

    function repositionInlineEdit() {
      setInlineEdit((current) => {
        if (!current) return null
        const position = inlinePosition(current.selection, current.expanded)
        return position ? { ...current, ...position } : current
      })
    }

    inlineEditDisposablesRef.current = [
      editor.onDidChangeCursorSelection(() => captureSelection()),
      editor.onDidChangeModel(() => captureSelection()),
      editor.onDidScrollChange(repositionInlineEdit),
      editor.onDidLayoutChange(repositionInlineEdit),
      editor.addAction({
        id: 'panepilot.latex.inline-edit',
        label: 'Edit Selection with AI',
        precondition: 'editorHasSelection',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.45,
        run: () => captureSelection(true)
      })
    ]
  }

  function expandInlineEdit() {
    const editor = editorRef.current
    if (!editor) return
    setInlineEdit((current) => {
      if (!current) return null
      const visible = editor.getScrolledVisiblePosition({
        lineNumber: current.selection.endLine,
        column: current.selection.endColumn
      })
      if (!visible) return current
      const layout = editor.getLayoutInfo()
      const panelHeight = 184
      const below = visible.top + visible.height + 7
      const above = below + panelHeight > layout.height - 8
      return {
        ...current,
        expanded: true,
        top: above ? Math.max(8, visible.top - panelHeight - 7) : below,
        left: Math.max(12, Math.min(visible.left, layout.width - 346)),
        above
      }
    })
    window.requestAnimationFrame(() => inlinePromptRef.current?.focus())
  }

  function closeInlineEdit() {
    setInlineEdit(null)
    editorRef.current?.focus()
  }

  async function submitInlineEdit() {
    if (!inlineEdit || !inlineEdit.instruction.trim() || sendingInlineEdit) return
    const request = inlineEdit
    setSendingInlineEdit(true)
    setInlineEdit((current) => current && { ...current, error: '' })
    try {
      if (request.selection.text.length > 20_000) {
        throw new Error('Select no more than 20,000 characters.')
      }
      if (dirty && !(await save())) return
      await onInlineEdit(request.selection, request.instruction)
      setInlineEdit(null)
    } catch (caught) {
      setInlineEdit((current) =>
        current
          ? {
              ...current,
              error: caught instanceof Error ? caught.message : String(caught)
            }
          : current
      )
    } finally {
      setSendingInlineEdit(false)
    }
  }

  function clearViewZones(editor: monaco.editor.IStandaloneCodeEditor) {
    if (!viewZoneIdsRef.current.length) return
    editor.changeViewZones((accessor) => {
      for (const id of viewZoneIdsRef.current) accessor.removeZone(id)
    })
    viewZoneIdsRef.current = []
  }

  function applyDecorations() {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    clearViewZones(editor)
    const maxLine = model.getLineCount()
    const decorations: monaco.editor.IModelDeltaDecoration[] = []
    for (const change of fileChanges?.highlights ?? []) {
      const line = Math.max(1, Math.min(maxLine, change.startLine))
      if (change.kind === 'deleted') continue
      const maxColumn = model.getLineMaxColumn(line)
      const startColumn = Math.max(1, Math.min(maxColumn, change.startColumn))
      const endColumn = Math.max(
        startColumn,
        Math.min(maxColumn, change.endColumn)
      )
      decorations.push({
        range: new monaco.Range(line, startColumn, line, endColumn),
        options: {
          isWholeLine: change.kind === 'added',
          className: `latex-change-${change.kind}`,
          linesDecorationsClassName: `latex-change-gutter-${change.kind}`,
          hoverMessage: {
            value:
              change.kind === 'modified'
                ? `Changed from: \`${change.originalText || 'empty line'}\``
                : 'Added by an Edit-mode chat'
          }
        }
      })
    }
    decorationsRef.current?.clear()
    decorationsRef.current = editor.createDecorationsCollection(decorations)

    editor.changeViewZones((accessor) => {
      for (const change of fileChanges?.highlights ?? []) {
        if (change.kind !== 'deleted') continue
        const node = document.createElement('div')
        node.className = 'latex-deleted-zone'
        node.textContent = change.originalText
        const id = accessor.addZone({
          afterLineNumber: Math.max(0, Math.min(maxLine, change.startLine - 1)),
          heightInLines: Math.max(1, change.originalText.split('\n').length),
          domNode: node
        })
        viewZoneIdsRef.current.push(id)
      }
    })
  }

  const sectionGroups = useMemo(
    () =>
      workspace.sections.map((section) => ({
        ...section,
        chats: chatCounts.get(section.id) ?? 0
      })),
    [workspace.sections, chatCounts]
  )

  return (
    <div className="latex-manuscript">
      <aside className="latex-outline">
        <header>
          <span className="eyebrow">DOCUMENT MAP</span>
          <strong>Sections</strong>
          <button
            className="icon-button"
            onClick={() => void onWorkspaceRefresh()}
            title="Rescan sections"
          >
            <RefreshCw size={13} />
          </button>
        </header>
        <button
          className={`latex-outline-main ${selectedSectionId == null && !reviewPath ? 'active' : ''}`}
          onClick={() => selectSection(null)}
        >
          <BookOpenText size={14} />
          <span>
            <strong>Whole document</strong>
            <small>{workspace.details.mainFile}</small>
          </span>
          {(chatCounts.get('project') ?? 0) > 0 && (
            <em>{chatCounts.get('project')}</em>
          )}
        </button>
        <div className="latex-section-list">
          {sectionGroups.map((section) => (
            <button
              key={section.id}
              className={selectedSectionId === section.id && !reviewPath ? 'active' : ''}
              style={{ paddingLeft: `${11 + Math.max(0, section.level - 2) * 13}px` }}
              onClick={() => selectSection(section)}
            >
              <ChevronRight size={11} />
              <span>
                <strong>{section.title}</strong>
                <small>
                  {section.sourceFile}:{section.startLine}
                </small>
              </span>
              {section.chats > 0 && <em>{section.chats}</em>}
            </button>
          ))}
          {!sectionGroups.length && (
            <p>
              No section commands found. Add <code>\section{'{Title}'}</code> to the main file.
            </p>
          )}
        </div>
        <button
          className={`latex-context-link ${workspace.contextAvailable ? '' : 'missing'}`}
          onClick={onOpenContext}
          disabled={!workspace.contextAvailable}
        >
          <FolderSearch size={14} />
          <span>
            <strong>{workspace.details.contextFolder}/</strong>
            <small>
              {workspace.contextAvailable ? 'Agent research context' : 'Folder not found'}
            </small>
          </span>
        </button>
      </aside>

      <section className="latex-source-pane">
        <header className="latex-source-toolbar">
          <FileText size={14} />
          <div>
            <strong>{path}</strong>
            <span>
              {selectedSection && selectedSection.sourceFile === path
                ? selectedSection.title
                : path === workspace.details.mainFile
                  ? 'Main document'
                  : 'Change review'}
            </span>
          </div>
          {dirty && <small className="latex-unsaved">Unsaved</small>}
          {fileChanges && (
            <small className="latex-file-change-count">
              <Sparkles size={10} />
              {fileChanges.additions + fileChanges.modifications + fileChanges.deletions} changes
            </small>
          )}
          <button
            className={`secondary-button latex-inline-chat-button ${
              inlineSession ? 'available' : ''
            }`}
            onClick={() => {
              setInlineEdit(null)
              setShowInlineChat((current) => !current)
              if (inlineSession) {
                void window.projectConsole.terminals.acknowledge(inlineSession.id)
              }
            }}
            aria-expanded={showInlineChat}
            title="Show the latest persistent inline-edit interaction"
          >
            {inlineSession ? (
              <StatusDot state={inlineSession.state} compact />
            ) : (
              <MessageSquareText size={12} />
            )}
            Inline chat
          </button>
          <button
            className="primary-button"
            onClick={() => void save()}
            disabled={!dirty || saving}
          >
            {saving ? <CircleDotDashed className="spin" size={13} /> : <Save size={13} />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>

        {totalChanges > 0 && (
          <div className="latex-change-ribbon">
            <Sparkles size={13} />
            <span>{totalChanges} agent changes</span>
            <div>
              {changes?.files.map((file) => (
                <button
                  key={file.path}
                  className={file.path === path ? 'active' : ''}
                  onClick={() => reviewFile(file.path)}
                >
                  {file.path}
                </button>
              ))}
            </div>
            <button
              className="latex-clear-changes"
              onClick={() => void onClearChanges()}
            >
              <Check size={12} /> Clear highlights
            </button>
          </div>
        )}

        {error ? (
          <div className="latex-editor-error">
            <FileText size={26} />
            <strong>Source file unavailable</strong>
            <p>{error}</p>
          </div>
        ) : (
          <div className={`latex-editor-shell ${loading ? 'loading' : ''}`}>
            <Editor
              path={`${project.id}/${path}`}
              language="latex"
              theme="panepilot-latex"
              value={draft}
              onChange={(value) => setDraft(value ?? '')}
              onMount={handleMount}
              options={{
                minimap: { enabled: false },
                fontFamily: '"SFMono-Regular", "Cascadia Code", monospace',
                fontSize: 12,
                lineHeight: 20,
                padding: { top: 17, bottom: 17 },
                renderLineHighlight: 'line',
                scrollBeyondLastLine: false,
                smoothScrolling: true,
                wordWrap: 'on',
                folding: true,
                glyphMargin: true,
                lineNumbersMinChars: 3,
                stickyScroll: { enabled: true }
              }}
            />
            {inlineEdit && (
              <div
                className={`latex-inline-edit ${
                  inlineEdit.expanded ? 'expanded' : 'collapsed'
                } ${inlineEdit.above ? 'above' : 'below'}`}
                style={{ top: inlineEdit.top, left: inlineEdit.left }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {inlineEdit.expanded ? (
                  <div className="latex-inline-card">
                    <header>
                      <span>
                        <Sparkles size={12} /> Inline edit
                      </span>
                      <small>
                        {inlineEdit.selection.path} · L{inlineEdit.selection.startLine}
                        {inlineEdit.selection.endLine !==
                          inlineEdit.selection.startLine &&
                          `–${inlineEdit.selection.endLine}`}
                      </small>
                      <button
                        type="button"
                        onClick={closeInlineEdit}
                        aria-label="Close inline edit"
                      >
                        ×
                      </button>
                    </header>
                    <textarea
                      ref={inlinePromptRef}
                      aria-label="Inline edit instruction"
                      value={inlineEdit.instruction}
                      onChange={(event) =>
                        setInlineEdit((current) =>
                          current
                            ? { ...current, instruction: event.target.value }
                            : current
                        )
                      }
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          closeInlineEdit()
                        } else if (
                          event.key === 'Enter' &&
                          (event.metaKey || event.ctrlKey)
                        ) {
                          event.preventDefault()
                          void submitInlineEdit()
                        }
                      }}
                      placeholder="Describe the change to this selection…"
                      rows={3}
                    />
                    <footer>
                      <span>
                        {inlineSession
                          ? `${inlineSession.name} · persistent Codex`
                          : 'Creates one hidden persistent Codex chat'}
                      </span>
                      <button
                        type="button"
                        className="latex-inline-submit"
                        onClick={() => void submitInlineEdit()}
                        disabled={
                          sendingInlineEdit ||
                          !inlineEdit.instruction.trim() ||
                          inlineEdit.selection.text.length > 20_000
                        }
                      >
                        <Send size={11} />
                        {sendingInlineEdit
                          ? 'Sending…'
                          : 'Send edit'}
                      </button>
                    </footer>
                    {inlineEdit.error && (
                      <p role="alert">{inlineEdit.error}</p>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="latex-inline-chip"
                    onClick={expandInlineEdit}
                    title="Ask a writing agent to edit this selection"
                  >
                    <Sparkles size={11} /> Edit selection
                  </button>
                )}
              </div>
            )}
            {showInlineChat && (
              <aside
                className="latex-inline-chat-viewer"
                aria-label="Latest inline edit chat"
              >
                <header>
                  <div>
                    <span className="eyebrow">LATEST INLINE EDIT</span>
                    <strong>Inline chat</strong>
                  </div>
                  {inlineSession && (
                    <small>
                      <StatusDot state={inlineSession.state} compact />
                      {inlineSession.name}
                    </small>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowInlineChat(false)}
                    aria-label="Close inline chat"
                  >
                    <X size={14} />
                  </button>
                </header>
                {inlineSession ? (
                  <div className="latex-inline-chat-terminal">
                    <ManagedTerminal
                      session={inlineSession}
                      projectFolder={project.folder}
                    />
                  </div>
                ) : (
                  <div className="latex-inline-chat-empty">
                    <Sparkles size={23} />
                    <strong>No inline edit yet</strong>
                    <p>
                      Select source text and send an edit. PanePilot will create
                      the hidden persistent Codex session here.
                    </p>
                  </div>
                )}
              </aside>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
