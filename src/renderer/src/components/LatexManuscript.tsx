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
  RefreshCw,
  Save,
  Sparkles
} from 'lucide-react'
import type {
  LatexChangeSet,
  LatexSection,
  LatexWorkspace,
  Project
} from '@shared/types'
import { addShowInFinderAction } from '../lib/monacoFinderAction'

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
  monaco.languages.setMonarchTokensProvider('latex', {
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\(?:part|chapter|section|subsection|subsubsection)\*?/, 'keyword'],
        [/\\[A-Za-z@]+/, 'type.identifier'],
        [/\$+/, 'delimiter'],
        [/[{}[\]]/, 'delimiter.bracket'],
        [/[&_^]/, 'operator']
      ]
    }
  })
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
  selectedSectionId: string | null
  chatCounts: Map<string, number>
  changes: LatexChangeSet | null
  onSelectSection(id: string | null): void
  onOpenContext(): void
  onClearChanges(): Promise<void>
  onWorkspaceRefresh(): Promise<void>
}

export function LatexManuscript({
  project,
  workspace,
  selectedSectionId,
  chatCounts,
  changes,
  onSelectSection,
  onOpenContext,
  onClearChanges,
  onWorkspaceRefresh
}: Props) {
  const [reviewPath, setReviewPath] = useState<string | null>(null)
  const [path, setPath] = useState(workspace.details.mainFile)
  const [savedContent, setSavedContent] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const finderActionRef = useRef<{ dispose(): void } | null>(null)
  const activeFinderPathRef = useRef(path)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const viewZoneIdsRef = useRef<string[]>([])
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
    },
    []
  )

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

  async function save() {
    setSaving(true)
    setError('')
    try {
      await window.projectConsole.files.save(project.id, path, draft)
      setSavedContent(draft)
      await onWorkspaceRefresh()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
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
          </div>
        )}
      </section>
    </div>
  )
}
