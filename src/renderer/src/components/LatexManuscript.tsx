import Editor, { loader, type OnMount } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import cssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import htmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenText,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDotDashed,
  FileText,
  FolderSearch,
  History,
  MessageSquarePlus,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  RotateCcw,
  Save,
  SaveAll,
  Send,
  Sparkles,
  Trash2,
  X
} from 'lucide-react'
import type {
  FilePreview,
  LatexChangeSet,
  LatexComment,
  LatexInlineEditHistory,
  LatexSection,
  LatexSourceSelection,
  LatexWorkspace,
  Project
} from '@shared/types'
import { latexMonarchLanguage } from '../lib/latexLanguage'
import {
  loadLatexManuscriptLayout,
  saveLatexManuscriptLayout
} from '../lib/latexManuscriptLayout'
import { latexGraphicAtColumn } from '../lib/latexGraphics'
import {
  loadLatexManuscriptView,
  saveLatexManuscriptView
} from '../lib/latexViewMemory'
import { addShowInFinderAction } from '../lib/monacoFinderAction'
import type { TerminalFileTarget } from '../lib/terminalFileLinks'

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
  inlineEdits: LatexInlineEditHistory[]
  comments: LatexComment[]
  inlineRunning: boolean
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
  ): Promise<LatexInlineEditHistory>
  onRollbackInlineEdit(editId: string): Promise<LatexInlineEditHistory>
  onDeleteInlineEdit(editId: string): Promise<void>
  onCreateComment(
    selection: LatexSourceSelection,
    body: string
  ): Promise<LatexComment>
  onDeleteComment(commentId: string): Promise<void>
  onOpenFile(target: TerminalFileTarget): void
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

interface CommentComposerState {
  selection: LatexSourceSelection
  top: number
  left: number
  above: boolean
  body: string
  error: string
}

interface CommentAnchor {
  top: number | null
  range: monaco.Range | null
  stale: boolean
}

function locateCommentRange(
  model: monaco.editor.ITextModel,
  comment: LatexComment
): { range: monaco.Range; stale: boolean } {
  const fixed = model.validateRange(
    new monaco.Range(
      comment.startLine,
      comment.startColumn,
      comment.endLine,
      comment.endColumn
    )
  )
  if (model.getValueInRange(fixed) === comment.selectedText) {
    return { range: fixed, stale: false }
  }

  const source = model.getValue()
  const anchored = `${comment.prefixContext}${comment.selectedText}${comment.suffixContext}`
  const anchoredAt = anchored ? source.indexOf(anchored) : -1
  if (anchoredAt >= 0 && source.indexOf(anchored, anchoredAt + 1) < 0) {
    const start = anchoredAt + comment.prefixContext.length
    return {
      range: monaco.Range.fromPositions(
        model.getPositionAt(start),
        model.getPositionAt(start + comment.selectedText.length)
      ),
      stale: false
    }
  }

  const first = source.indexOf(comment.selectedText)
  if (first >= 0 && source.indexOf(comment.selectedText, first + 1) < 0) {
    return {
      range: monaco.Range.fromPositions(
        model.getPositionAt(first),
        model.getPositionAt(first + comment.selectedText.length)
      ),
      stale: false
    }
  }
  return { range: fixed, stale: true }
}

function inlineEditStatusLabel(status: LatexInlineEditHistory['status']): string {
  if (status === 'rolled-back') return 'Rolled back'
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function latexOutlineSignature(source: string): string {
  return (
    source.match(
      /^\s*\\(?:part|chapter|section|subsection|subsubsection|paragraph|subparagraph|input|include)\b.*$/gm
    ) ?? []
  ).join('\n')
}

export function LatexManuscript({
  project,
  workspace,
  inlineEdits,
  comments,
  inlineRunning,
  selectedSectionId,
  chatCounts,
  changes,
  onSelectSection,
  onOpenContext,
  onClearChanges,
  onWorkspaceRefresh,
  onInlineEdit,
  onRollbackInlineEdit,
  onDeleteInlineEdit,
  onCreateComment,
  onDeleteComment,
  onOpenFile
}: Props) {
  const rememberedViewRef = useRef(loadLatexManuscriptView(project.id))
  const pendingViewRestoreRef = useRef(rememberedViewRef.current)
  const rememberedPath = rememberedViewRef.current?.path
  const [reviewPath, setReviewPath] = useState<string | null>(
    rememberedPath && rememberedPath !== workspace.details.mainFile
      ? rememberedPath
      : null
  )
  const [path, setPath] = useState(
    rememberedPath ?? workspace.details.mainFile
  )
  const [savedContent, setSavedContent] = useState('')
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [sendingInlineEdit, setSendingInlineEdit] = useState(false)
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null)
  const [commentComposer, setCommentComposer] =
    useState<CommentComposerState | null>(null)
  const [savingComment, setSavingComment] = useState(false)
  const [commentError, setCommentError] = useState('')
  const [commentAnchors, setCommentAnchors] = useState<Record<string, CommentAnchor>>({})
  const [manuscriptLayout, setManuscriptLayout] = useState(() =>
    loadLatexManuscriptLayout(project.id)
  )
  const [showInlineHistory, setShowInlineHistory] = useState(false)
  const [expandedInlineEditId, setExpandedInlineEditId] = useState<string | null>(null)
  const [busyInlineEditId, setBusyInlineEditId] = useState<string | null>(null)
  const [inlineHistoryError, setInlineHistoryError] = useState('')
  const [error, setError] = useState('')
  const [saveError, setSaveError] = useState('')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const finderActionRef = useRef<{ dispose(): void } | null>(null)
  const graphicHoverRef = useRef<{ dispose(): void } | null>(null)
  const graphicCommandRef = useRef<{ dispose(): void } | null>(null)
  const graphicPreviewCacheRef = useRef(
    new Map<string, Promise<FilePreview | null>>()
  )
  const graphicResolutionCacheRef = useRef(
    new Map<string, Promise<{ path: string; preview: FilePreview } | null>>()
  )
  const activeFinderPathRef = useRef(path)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const commentDecorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const viewZoneIdsRef = useRef<string[]>([])
  const inlineEditDisposablesRef = useRef<{ dispose(): void }[]>([])
  const inlinePromptRef = useRef<HTMLTextAreaElement | null>(null)
  const commentPromptRef = useRef<HTMLTextAreaElement | null>(null)
  const commentsRef = useRef<LatexComment[]>([])
  const commentFrameRef = useRef(0)
  const failedAutoSaveRef = useRef('')
  const viewMemoryFrameRef = useRef(0)
  const dirty = draft !== savedContent
  const inlineBusy = sendingInlineEdit || inlineRunning
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
  const commentsForPath = useMemo(
    () => comments.filter((comment) => comment.path === path),
    [comments, path]
  )
  commentsRef.current = commentsForPath

  function rememberCurrentView(): void {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    if (!editor || !selection) return
    saveLatexManuscriptView(project.id, {
      path: activeFinderPathRef.current,
      selection: {
        startLineNumber: selection.startLineNumber,
        startColumn: selection.startColumn,
        endLineNumber: selection.endLineNumber,
        endColumn: selection.endColumn
      },
      scrollTop: editor.getScrollTop(),
      scrollLeft: editor.getScrollLeft()
    })
  }

  function scheduleViewMemory(): void {
    if (viewMemoryFrameRef.current) return
    viewMemoryFrameRef.current = window.requestAnimationFrame(() => {
      viewMemoryFrameRef.current = 0
      rememberCurrentView()
    })
  }

  function updateManuscriptLayout(
    update: Partial<typeof manuscriptLayout>
  ): void {
    setManuscriptLayout((current) => {
      const next = { ...current, ...update }
      saveLatexManuscriptLayout(project.id, next)
      return next
    })
    window.requestAnimationFrame(() => editorRef.current?.layout())
  }

  function updateCommentAnchors(): void {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const next: Record<string, CommentAnchor> = {}
    for (const comment of commentsRef.current) {
      const located = locateCommentRange(model, comment)
      const visible = editor.getScrolledVisiblePosition(
        located.range.getStartPosition()
      )
      next[comment.id] = {
        top: visible?.top ?? null,
        range: located.range,
        stale: located.stale
      }
    }
    setCommentAnchors(next)
  }

  function scheduleCommentAnchors(): void {
    if (commentFrameRef.current) return
    commentFrameRef.current = window.requestAnimationFrame(() => {
      commentFrameRef.current = 0
      updateCommentAnchors()
    })
  }

  function applyCommentDecorations(): void {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const decorations = commentsRef.current.flatMap(
      (comment): monaco.editor.IModelDeltaDecoration[] => {
        const located = locateCommentRange(model, comment)
        if (located.stale) return []
        return [{
          range: located.range,
          options: {
            className: 'latex-comment-selection',
            linesDecorationsClassName: 'latex-comment-gutter',
            hoverMessage: { value: `Comment: ${comment.body}` },
            stickiness:
              monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
          }
        }]
      }
    )
    commentDecorationsRef.current?.clear()
    commentDecorationsRef.current =
      editor.createDecorationsCollection(decorations)
    scheduleCommentAnchors()
  }

  async function load(nextPath: string, revealSection?: LatexSection | null) {
    setLoading(true)
    setError('')
    setSaveError('')
    try {
      const preview = await window.projectConsole.files.preview(project.id, nextPath)
      if (preview.binary || preview.truncated) {
        throw new Error('LaTeX source files must be UTF-8 text no larger than 1 MB.')
      }
      setPath(nextPath)
      graphicPreviewCacheRef.current.clear()
      graphicResolutionCacheRef.current.clear()
      setSavedContent(preview.content)
      setDraft(preview.content)
      requestAnimationFrame(() => {
        if (revealSection && revealSection.sourceFile === nextPath) {
          editorRef.current?.revealLineInCenter(revealSection.startLine)
          editorRef.current?.setPosition({ lineNumber: revealSection.startLine, column: 1 })
        }
      })
    } catch (caught) {
      if (
        pendingViewRestoreRef.current?.path === nextPath &&
        nextPath !== workspace.details.mainFile
      ) {
        pendingViewRestoreRef.current = null
        setReviewPath(null)
        return
      }
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

  useLayoutEffect(() => {
    const remembered = pendingViewRestoreRef.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (
      loading ||
      !remembered ||
      remembered.path !== path ||
      !editor ||
      !model
    ) {
      return
    }
    const selection = model.validateRange(
      new monaco.Range(
        remembered.selection.startLineNumber,
        remembered.selection.startColumn,
        remembered.selection.endLineNumber,
        remembered.selection.endColumn
      )
    )
    editor.setSelection(selection)
    editor.setScrollPosition({
      scrollTop: remembered.scrollTop,
      scrollLeft: remembered.scrollLeft
    })
    pendingViewRestoreRef.current = null
  }, [loading, path, savedContent])

  useEffect(
    () => () => {
      if (viewMemoryFrameRef.current) {
        window.cancelAnimationFrame(viewMemoryFrameRef.current)
        viewMemoryFrameRef.current = 0
      }
      if (commentFrameRef.current) {
        window.cancelAnimationFrame(commentFrameRef.current)
        commentFrameRef.current = 0
      }
      rememberCurrentView()
      finderActionRef.current?.dispose()
      graphicHoverRef.current?.dispose()
      graphicCommandRef.current?.dispose()
      commentDecorationsRef.current?.clear()
      for (const disposable of inlineEditDisposablesRef.current) {
        disposable.dispose()
      }
      inlineEditDisposablesRef.current = []
    },
    []
  )

  useEffect(() => {
    setInlineEdit(null)
    setCommentComposer(null)
    setCommentError('')
    setManuscriptLayout(loadLatexManuscriptLayout(project.id))
    setShowInlineHistory(false)
    setExpandedInlineEditId(null)
    setInlineHistoryError('')
    setSaveError('')
    failedAutoSaveRef.current = ''
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
        if (dirty && !saving && !inlineBusy) void save()
      }
    }
    window.addEventListener('keydown', saveShortcut)
    return () => window.removeEventListener('keydown', saveShortcut)
  }, [dirty, saving, inlineBusy, draft, path])

  useEffect(() => {
    if (
      !manuscriptLayout.autoSave ||
      !dirty ||
      loading ||
      saving ||
      inlineBusy ||
      savingComment
    ) {
      return
    }
    const snapshot = draft
    const failureKey = `${path}\u0000${snapshot}`
    if (failedAutoSaveRef.current === failureKey) return
    const refreshOutline =
      latexOutlineSignature(snapshot) !== latexOutlineSignature(savedContent)
    const timer = window.setTimeout(() => {
      void save(snapshot, refreshOutline, true)
    }, 700)
    return () => window.clearTimeout(timer)
  }, [
    manuscriptLayout.autoSave,
    dirty,
    draft,
    savedContent,
    path,
    loading,
    saving,
    inlineBusy,
    savingComment
  ])

  useEffect(() => {
    applyDecorations()
  }, [fileChanges, draft])

  useEffect(() => {
    applyCommentDecorations()
  }, [commentsForPath, draft, path])

  useEffect(() => {
    if (!showInlineHistory) return
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setShowInlineHistory(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [showInlineHistory])

  async function save(
    content = draft,
    refreshWorkspace = true,
    automatic = false
  ): Promise<boolean> {
    if (inlineBusy || saving) return false
    const targetPath = path
    setSaving(true)
    setSaveError('')
    try {
      await window.projectConsole.files.save(project.id, targetPath, content)
      if (activeFinderPathRef.current === targetPath) setSavedContent(content)
      failedAutoSaveRef.current = ''
      if (refreshWorkspace) {
        try {
          await onWorkspaceRefresh()
        } catch (caught) {
          setSaveError(
            `Saved, but the Document Map could not refresh: ${
              caught instanceof Error ? caught.message : String(caught)
            }`
          )
        }
      }
      return true
    } catch (caught) {
      if (automatic) failedAutoSaveRef.current = `${targetPath}\u0000${content}`
      setSaveError(caught instanceof Error ? caught.message : String(caught))
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

  async function resolveGraphicPreview(
    candidates: string[],
    source: string
  ): Promise<{ path: string; preview: FilePreview } | null> {
    const resolutionKey = `${project.id}:${activeFinderPathRef.current}:${source}`
    let resolution = graphicResolutionCacheRef.current.get(resolutionKey)
    if (!resolution) {
      resolution = (async () => {
        let availableCandidates = candidates
        if (candidates.length > 2) {
          try {
            const candidateSet = new Set(candidates)
            const matches = await window.projectConsole.files.search(
              project.id,
              source.split('/').at(-1) ?? source
            )
            availableCandidates = matches
              .filter(
                (match) =>
                  match.kind === 'file' && candidateSet.has(match.path)
              )
              .map((match) => match.path)
          } catch {
            availableCandidates = []
          }
        }
        for (const candidate of availableCandidates) {
          const cacheKey = `${project.id}:${candidate}`
          let pending = graphicPreviewCacheRef.current.get(cacheKey)
          if (!pending) {
            while (graphicPreviewCacheRef.current.size >= 6) {
              const oldest = graphicPreviewCacheRef.current.keys().next().value
              if (typeof oldest !== 'string') break
              graphicPreviewCacheRef.current.delete(oldest)
            }
            pending = window.projectConsole.files
              .preview(project.id, candidate)
              .catch(() => null)
            graphicPreviewCacheRef.current.set(cacheKey, pending)
          }
          const preview = await pending
          if (preview) return { path: candidate, preview }
        }
        return null
      })()
      while (graphicResolutionCacheRef.current.size >= 12) {
        const oldest = graphicResolutionCacheRef.current.keys().next().value
        if (typeof oldest !== 'string') break
        graphicResolutionCacheRef.current.delete(oldest)
      }
      graphicResolutionCacheRef.current.set(resolutionKey, resolution)
    }
    return resolution
  }

  const handleMount: OnMount = (editor) => {
    editorRef.current = editor
    finderActionRef.current?.dispose()
    graphicHoverRef.current?.dispose()
    graphicCommandRef.current?.dispose()
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
    const openGraphicCommand = `panepilot.latex.open-graphic.${project.id.replace(
      /[^a-z0-9_-]/gi,
      '-'
    )}`
    graphicCommandRef.current = monaco.editor.registerCommand(
      openGraphicCommand,
      (_accessor, target: unknown) => {
        if (typeof target !== 'string') return
        onOpenFile({ path: target, line: null, column: null })
      }
    )
    graphicHoverRef.current = monaco.languages.registerHoverProvider('latex', {
      provideHover: async (model, position, token) => {
        if (model !== editor.getModel()) return null
        const reference = latexGraphicAtColumn(
          model.getLineContent(position.lineNumber),
          activeFinderPathRef.current,
          position.column
        )
        if (!reference) return null
        const resolved = await resolveGraphicPreview(
          reference.candidates,
          reference.source
        )
        if (!resolved || token.isCancellationRequested) return null
        const commandUri = `command:${openGraphicCommand}?${encodeURIComponent(
          JSON.stringify([resolved.path])
        )}`
        const safeLabel = resolved.path.replace(/[`\[\]]/g, '\\$&')
        let value = ''
        if (resolved.preview.imageDataUrl) {
          value = `[![Open ${safeLabel} in Files](${resolved.preview.imageDataUrl})](${commandUri})\n\n`
        } else if (resolved.preview.imageMimeType && resolved.preview.truncated) {
          value = '**Preview unavailable:** this image exceeds 5 MB.\n\n'
        } else {
          value = '**Inline preview unavailable for this graphic format.**\n\n'
        }
        value += `[Open \`${safeLabel}\` in Files](${commandUri})`
        const markdown: monaco.IMarkdownString = {
          value,
          isTrusted: { enabledCommands: [openGraphicCommand] },
          supportHtml: true
        }
        return {
          range: new monaco.Range(
            position.lineNumber,
            reference.startColumn,
            position.lineNumber,
            reference.endColumn
          ),
          contents: [markdown]
        }
      }
    })
    applyDecorations()
    applyCommentDecorations()
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

    function captureSelection(expanded = false, forComment = false) {
      const model = editor.getModel()
      const range = editor.getSelection()
      if (!model || !range || range.isEmpty()) {
        setInlineEdit(null)
        if (!forComment) setCommentComposer(null)
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
      if (forComment) {
        setInlineEdit(null)
        setCommentComposer({
          selection,
          ...position,
          body: '',
          error:
            selection.text.length > 20_000
              ? 'Select no more than 20,000 characters.'
              : ''
        })
        window.requestAnimationFrame(() => commentPromptRef.current?.focus())
        return
      }
      setCommentComposer(null)
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
      setCommentComposer((current) => {
        if (!current) return null
        const position = inlinePosition(current.selection, true)
        return position ? { ...current, ...position } : current
      })
    }

    inlineEditDisposablesRef.current = [
      editor.onDidChangeCursorSelection(() => {
        scheduleViewMemory()
        captureSelection()
      }),
      editor.onDidChangeModel(() => {
        captureSelection()
        scheduleCommentAnchors()
      }),
      editor.onDidScrollChange(() => {
        scheduleViewMemory()
        repositionInlineEdit()
        scheduleCommentAnchors()
      }),
      editor.onDidLayoutChange(() => {
        repositionInlineEdit()
        scheduleCommentAnchors()
      }),
      editor.addAction({
        id: 'panepilot.latex.inline-edit',
        label: 'Edit Selection with AI',
        precondition: 'editorHasSelection',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.45,
        run: () => captureSelection(true)
      }),
      editor.addAction({
        id: 'panepilot.latex.add-comment',
        label: 'Add Comment to Selection',
        precondition: 'editorHasSelection',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.46,
        run: () => captureSelection(true, true)
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

  function openCommentComposer() {
    const editor = editorRef.current
    if (!editor || !inlineEdit) return
    const visible = editor.getScrolledVisiblePosition({
      lineNumber: inlineEdit.selection.endLine,
      column: inlineEdit.selection.endColumn
    })
    if (!visible) return
    const layout = editor.getLayoutInfo()
    const panelHeight = 184
    const below = visible.top + visible.height + 7
    const above = below + panelHeight > layout.height - 8
    setCommentComposer({
      selection: inlineEdit.selection,
      top: above ? Math.max(8, visible.top - panelHeight - 7) : below,
      left: Math.max(12, Math.min(visible.left, layout.width - 346)),
      above,
      body: '',
      error: inlineEdit.error
    })
    setInlineEdit(null)
    window.requestAnimationFrame(() => commentPromptRef.current?.focus())
  }

  function closeCommentComposer() {
    setCommentComposer(null)
    editorRef.current?.focus()
  }

  async function submitComment() {
    if (
      !commentComposer ||
      !commentComposer.body.trim() ||
      savingComment ||
      saving
    ) return
    const request = commentComposer
    setCommentComposer((current) => current && { ...current, error: '' })
    try {
      const model = editorRef.current?.getModel()
      if (!model || activeFinderPathRef.current !== request.selection.path) {
        throw new Error('The selected source file is no longer open.')
      }
      const range = model.validateRange(
        new monaco.Range(
          request.selection.startLine,
          request.selection.startColumn,
          request.selection.endLine,
          request.selection.endColumn
        )
      )
      if (model.getValueInRange(range) !== request.selection.text) {
        throw new Error(
          'The selected text changed before the comment was added. Select it again and retry.'
        )
      }
      setSavingComment(true)
      if (dirty && !(await save())) return
      await onCreateComment(request.selection, request.body)
      setCommentComposer(null)
      setCommentError('')
      updateManuscriptLayout({ commentsHidden: false })
    } catch (caught) {
      setCommentComposer((current) =>
        current
          ? {
              ...current,
              error: caught instanceof Error ? caught.message : String(caught)
            }
          : current
      )
    } finally {
      setSavingComment(false)
    }
  }

  function revealComment(comment: LatexComment) {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    const located = locateCommentRange(model, comment)
    editor.setSelection(located.range)
    editor.revealRangeInCenterIfOutsideViewport(located.range)
    editor.focus()
    scheduleCommentAnchors()
  }

  async function deleteComment(comment: LatexComment) {
    if (!window.confirm('Delete this comment? The manuscript will not change.')) return
    setCommentError('')
    try {
      await onDeleteComment(comment.id)
    } catch (caught) {
      setCommentError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function submitInlineEdit() {
    if (
      !inlineEdit ||
      !inlineEdit.instruction.trim() ||
      inlineBusy ||
      saving
    ) {
      return
    }
    const request = inlineEdit
    setInlineEdit((current) => current && { ...current, error: '' })
    let trackedModel: monaco.editor.ITextModel | null = null
    let trackedDecorationId: string | null = null
    let dispatched = false
    try {
      if (request.selection.text.length > 20_000) {
        throw new Error('Select no more than 20,000 characters.')
      }
      if (dirty && !(await save())) return

      const editor = editorRef.current
      const model = editor?.getModel() ?? null
      if (model && activeFinderPathRef.current === request.selection.path) {
        const range = model.validateRange(
          new monaco.Range(
            request.selection.startLine,
            request.selection.startColumn,
            request.selection.endLine,
            request.selection.endColumn
          )
        )
        if (model.getValueInRange(range) !== request.selection.text) {
          throw new Error(
            'The selected text changed before the inline edit started. Select it again and retry.'
          )
        }
        trackedModel = model
        const decorationIds = model.deltaDecorations([], [
          {
            range,
            options: {
              stickiness:
                monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges
            }
          }
        ])
        trackedDecorationId = decorationIds[0] ?? null
      }

      dispatched = true
      setSendingInlineEdit(true)
      setInlineEdit(null)
      const edit = await onInlineEdit(request.selection, request.instruction)
      const activeModel = editorRef.current?.getModel()
      if (
        trackedModel &&
        !trackedModel.isDisposed() &&
        activeModel === trackedModel &&
        activeFinderPathRef.current === edit.path
      ) {
        const preview = await window.projectConsole.files.preview(
          project.id,
          edit.path
        )
        if (!preview.binary && !preview.truncated) {
          const range = trackedDecorationId
            ? trackedModel.getDecorationRange(trackedDecorationId)
            : null
          if (
            range &&
            edit.replacementText != null &&
            trackedModel.getValueInRange(range) === edit.originalText
          ) {
            trackedModel.pushEditOperations(
              [],
              [
                {
                  range,
                  text: edit.replacementText,
                  forceMoveMarkers: true
                }
              ],
              () => null
            )
          } else if (trackedModel.getValue() !== preview.content) {
            setInlineHistoryError(
              'The inline edit finished, but you changed its selected text while it was running. PanePilot kept your local draft; the applied revision remains in the editorial trail.'
            )
          }
          setSavedContent(preview.content)
          setDraft(trackedModel.getValue())
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught)
      if (dispatched) {
        setInlineHistoryError(message)
        setShowInlineHistory(true)
      } else {
        setInlineEdit((current) =>
          current ? { ...current, error: message } : current
        )
      }
    } finally {
      if (
        trackedModel &&
        !trackedModel.isDisposed() &&
        trackedDecorationId
      ) {
        trackedModel.deltaDecorations([trackedDecorationId], [])
      }
      setSendingInlineEdit(false)
    }
  }

  async function rollbackInlineEdit(edit: LatexInlineEditHistory) {
    if (
      !window.confirm(
        'Restore the original selected text? The editorial-history entry will remain.'
      )
    ) {
      return
    }
    setBusyInlineEditId(edit.id)
    setInlineHistoryError('')
    try {
      const rolledBack = await onRollbackInlineEdit(edit.id)
      await load(rolledBack.path)
    } catch (caught) {
      setInlineHistoryError(
        caught instanceof Error ? caught.message : String(caught)
      )
    } finally {
      setBusyInlineEditId(null)
    }
  }

  async function deleteInlineEdit(edit: LatexInlineEditHistory) {
    if (!window.confirm('Delete this editorial-history entry? The document will not change.')) {
      return
    }
    setBusyInlineEditId(edit.id)
    setInlineHistoryError('')
    try {
      await onDeleteInlineEdit(edit.id)
      setExpandedInlineEditId((current) =>
        current === edit.id ? null : current
      )
    } catch (caught) {
      setInlineHistoryError(
        caught instanceof Error ? caught.message : String(caught)
      )
    } finally {
      setBusyInlineEditId(null)
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
    <div
      className={`latex-manuscript ${
        manuscriptLayout.mapHidden ? 'map-hidden' : ''
      } ${manuscriptLayout.commentsHidden ? 'comments-hidden' : 'comments-visible'}`}
    >
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
          <button
            className="icon-button"
            onClick={() => updateManuscriptLayout({ mapHidden: true })}
            title="Hide document map"
            aria-label="Hide document map"
          >
            <PanelLeftClose size={13} />
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
          {manuscriptLayout.mapHidden && (
            <button
              className="secondary-button latex-layout-button"
              onClick={() => updateManuscriptLayout({ mapHidden: false })}
              title="Show document map"
            >
              <PanelLeftOpen size={12} />
              Map
            </button>
          )}
          <button
            className={`secondary-button latex-layout-button latex-comments-toggle ${
              manuscriptLayout.commentsHidden ? '' : 'active'
            }`}
            onClick={() =>
              updateManuscriptLayout({
                commentsHidden: !manuscriptLayout.commentsHidden
              })
            }
            aria-expanded={!manuscriptLayout.commentsHidden}
            title="Show comments beside their manuscript selections"
          >
            <MessageSquareText size={12} />
            Comments{comments.length ? ` ${comments.length}` : ''}
          </button>
          <button
            className={`secondary-button latex-inline-chat-button ${
              inlineEdits.length ? 'available' : ''
            }`}
            onClick={() => {
              setInlineEdit(null)
              setInlineHistoryError('')
              setShowInlineHistory((current) => !current)
            }}
            aria-expanded={showInlineHistory}
            title="Show accumulated inline editorial changes"
          >
            {inlineBusy ? (
              <CircleDotDashed className="spin" size={12} />
            ) : (
              <History size={12} />
            )}
            Edits{inlineEdits.length ? ` ${inlineEdits.length}` : ''}
          </button>
          <button
            className={`secondary-button latex-layout-button latex-autosave-toggle ${
              manuscriptLayout.autoSave ? 'active' : ''
            }`}
            onClick={() =>
              updateManuscriptLayout({ autoSave: !manuscriptLayout.autoSave })
            }
            aria-pressed={manuscriptLayout.autoSave}
            title={
              manuscriptLayout.autoSave
                ? 'Auto-save is on; click to turn it off'
                : 'Auto-save is off; click to turn it on'
            }
          >
            <SaveAll size={12} />
            Auto {manuscriptLayout.autoSave ? 'on' : 'off'}
          </button>
          <button
            className="primary-button"
            onClick={() => void save()}
            disabled={!dirty || saving || inlineBusy}
            title={
              inlineBusy
                ? 'Saving is available as soon as the pending inline revision finishes'
                : 'Save the current LaTeX source'
            }
          >
            {saving ? <CircleDotDashed className="spin" size={13} /> : <Save size={13} />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </header>

        {saveError && (
          <div className="latex-save-error" role="alert">
            <span>{saveError}</span>
            <button
              type="button"
              onClick={() => setSaveError('')}
              aria-label="Dismiss save error"
            >
              <X size={12} />
            </button>
          </div>
        )}

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
          <div className="latex-editor-stage">
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
                        {inlineBusy
                          ? 'Another editorial change is still running'
                          : 'Codex applies the change directly to this selection'}
                      </span>
                      <button
                        type="button"
                        className="latex-inline-submit"
                        onClick={() => void submitInlineEdit()}
                        disabled={
                          inlineBusy ||
                          !inlineEdit.instruction.trim() ||
                          inlineEdit.selection.text.length > 20_000
                        }
                      >
                        <Send size={11} />
                        {inlineBusy
                          ? 'Applying…'
                          : 'Apply edit'}
                      </button>
                    </footer>
                    {inlineEdit.error && (
                      <p role="alert">{inlineEdit.error}</p>
                    )}
                  </div>
                ) : (
                  <div className="latex-selection-actions">
                    <button
                      type="button"
                      className="latex-inline-chip"
                      onClick={expandInlineEdit}
                      title="Ask a writing agent to edit this selection"
                    >
                      <Sparkles size={11} /> Edit
                    </button>
                    <button
                      type="button"
                      className="latex-comment-chip"
                      onClick={openCommentComposer}
                      title="Add a margin comment to this selection"
                    >
                      <MessageSquarePlus size={11} /> Comment
                    </button>
                  </div>
                )}
              </div>
            )}
            {commentComposer && (
              <div
                className={`latex-inline-edit latex-comment-composer ${
                  commentComposer.above ? 'above' : 'below'
                }`}
                style={{ top: commentComposer.top, left: commentComposer.left }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <div className="latex-inline-card">
                  <header>
                    <span>
                      <MessageSquarePlus size={12} /> Margin comment
                    </span>
                    <small>
                      {commentComposer.selection.path} · L
                      {commentComposer.selection.startLine}
                    </small>
                    <button
                      type="button"
                      onClick={closeCommentComposer}
                      aria-label="Close comment composer"
                    >
                      ×
                    </button>
                  </header>
                  <textarea
                    ref={commentPromptRef}
                    aria-label="Comment"
                    value={commentComposer.body}
                    onChange={(event) =>
                      setCommentComposer((current) =>
                        current ? { ...current, body: event.target.value } : current
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        closeCommentComposer()
                      } else if (
                        event.key === 'Enter' &&
                        (event.metaKey || event.ctrlKey)
                      ) {
                        event.preventDefault()
                        void submitComment()
                      }
                    }}
                    placeholder="Leave an editorial note on this selection…"
                    rows={3}
                  />
                  <footer>
                    <span>The note stays attached to the selected source</span>
                    <button
                      type="button"
                      className="latex-comment-submit"
                      onClick={() => void submitComment()}
                      disabled={saving || savingComment || !commentComposer.body.trim()}
                    >
                      <MessageSquarePlus size={11} />
                      {savingComment ? 'Adding…' : 'Add comment'}
                    </button>
                  </footer>
                  {commentComposer.error && (
                    <p role="alert">{commentComposer.error}</p>
                  )}
                </div>
              </div>
            )}
            {showInlineHistory && (
              <aside
                className="latex-inline-chat-viewer"
                aria-label="Inline editorial history"
              >
                <header>
                  <div>
                    <span className="eyebrow">EDITORIAL TRAIL</span>
                    <strong>Inline edits</strong>
                  </div>
                  <small>
                    {inlineBusy
                      ? 'Applying change…'
                      : `${inlineEdits.length} saved ${inlineEdits.length === 1 ? 'edit' : 'edits'}`}
                  </small>
                  <button
                    type="button"
                    onClick={() => setShowInlineHistory(false)}
                    aria-label="Close editorial history"
                  >
                    <X size={14} />
                  </button>
                </header>
                {inlineHistoryError && (
                  <p className="latex-inline-history-error" role="alert">
                    {inlineHistoryError}
                  </p>
                )}
                {inlineEdits.length ? (
                  <div className="latex-inline-history-list">
                    {inlineEdits.map((edit, index) => {
                      const expanded = expandedInlineEditId === edit.id
                      const busy = busyInlineEditId === edit.id
                      return (
                        <article
                          key={edit.id}
                          className={`latex-inline-history-pill ${edit.status} ${
                            expanded ? 'expanded' : ''
                          }`}
                        >
                          <button
                            type="button"
                            className="latex-inline-history-summary"
                            onClick={() =>
                              setExpandedInlineEditId((current) =>
                                current === edit.id ? null : edit.id
                              )
                            }
                            aria-expanded={expanded}
                          >
                            <span className="latex-inline-history-index">
                              {String(inlineEdits.length - index).padStart(2, '0')}
                            </span>
                            <span>
                              <strong>{edit.instruction}</strong>
                              <small>
                                {edit.path} · L{edit.startLine} ·{' '}
                                {new Date(edit.createdAt).toLocaleString()}
                              </small>
                            </span>
                            <em>{inlineEditStatusLabel(edit.status)}</em>
                            <ChevronDown size={13} />
                          </button>
                          {expanded && (
                            <div className="latex-inline-history-detail">
                              <div className="latex-inline-revision-pair">
                                <section>
                                  <span>Before</span>
                                  <p>{edit.originalText}</p>
                                </section>
                                <section>
                                  <span>After</span>
                                  <p>{edit.replacementText ?? 'No replacement was applied.'}</p>
                                </section>
                              </div>
                              {edit.modelOutput && (
                                <section className="latex-inline-model-note">
                                  <span>Codex note</span>
                                  <p>{edit.modelOutput}</p>
                                </section>
                              )}
                              {edit.error && (
                                <p className="latex-inline-item-error">{edit.error}</p>
                              )}
                              <footer>
                                {edit.status === 'applied' && (
                                  <button
                                    type="button"
                                    onClick={() => void rollbackInlineEdit(edit)}
                                    disabled={busy}
                                  >
                                    <RotateCcw size={12} />
                                    Restore original
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="delete"
                                  onClick={() => void deleteInlineEdit(edit)}
                                  disabled={busy || edit.status === 'running'}
                                >
                                  <Trash2 size={12} />
                                  Delete history
                                </button>
                              </footer>
                            </div>
                          )}
                        </article>
                      )
                    })}
                  </div>
                ) : (
                  <div className="latex-inline-chat-empty">
                    <Sparkles size={23} />
                    <strong>No editorial changes yet</strong>
                    <p>
                      Select manuscript text and apply an edit. Its request,
                      before text, replacement, and Codex note will collect here.
                    </p>
                  </div>
                )}
              </aside>
            )}
            </div>
            {!manuscriptLayout.commentsHidden && (
              <aside className="latex-comment-margin" aria-label="Manuscript comments">
                <div className="latex-comment-margin-label">
                  <span>PROOF NOTES</span>
                  <strong>{commentsForPath.length}</strong>
                </div>
                {commentError && (
                  <p className="latex-comment-error" role="alert">{commentError}</p>
                )}
                {!commentsForPath.length && (
                  <div className="latex-comment-empty">
                    <MessageSquareText size={17} />
                    <span>Select text, then choose Comment.</span>
                  </div>
                )}
                {commentsForPath.map((comment, index) => {
                  const anchor = commentAnchors[comment.id]
                  if (!anchor || anchor.top == null) return null
                  return (
                    <article
                      key={comment.id}
                      className={`latex-comment-card ${anchor.stale ? 'stale' : ''}`}
                      style={{ top: anchor.top }}
                    >
                      <button
                        type="button"
                        className="latex-comment-card-main"
                        onClick={() => revealComment(comment)}
                        title="Reveal commented text"
                      >
                        <span className="latex-comment-number">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span>
                          <strong>{comment.body}</strong>
                          <small>
                            L{comment.startLine} · “{comment.selectedText.replace(/\s+/g, ' ').trim()}”
                          </small>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="latex-comment-delete"
                        onClick={() => void deleteComment(comment)}
                        aria-label={`Delete comment ${index + 1}`}
                        title="Delete comment"
                      >
                        <Trash2 size={11} />
                      </button>
                      {anchor.stale && <em>Text moved</em>}
                    </article>
                  )
                })}
              </aside>
            )}
          </div>
        )}
      </section>
    </div>
  )
}
