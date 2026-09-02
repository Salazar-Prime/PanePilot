import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import type {
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent
} from 'react'
import {
  Activity,
  FileClock,
  Files,
  FileType2,
  FileText,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareText,
  PanelRightOpen,
  Play
} from 'lucide-react'
import type {
  LatexChangeSet,
  LatexComment,
  LatexInlineEditHistory,
  LatexSourceSelection,
  LatexWorkspace,
  StartLatexChatInput
} from '@shared/types'
import type {
  ProjectFileOpenRequest,
  TerminalFileTarget
} from '../lib/terminalFileLinks'
import type { ProjectWorkspaceProps } from '../projectTypeRegistry'
import {
  type ProjectShortcutAction,
  useProjectShortcuts
} from '../lib/projectShortcuts'
import {
  clampLatexChatWidth,
  loadLatexChatLayout,
  MAX_LATEX_CHAT_WIDTH,
  MIN_LATEX_CHAT_WIDTH,
  saveLatexChatLayout
} from '../lib/latexChatLayout'
import { ActionsPanel } from './ActionsPanel'
import { ChatHistoryPanel } from './ChatHistoryPanel'
import { FilesPanel } from './FilesPanel'
import { HistoryPanel } from './HistoryPanel'
import { LatexAgentPane } from './LatexAgentPane'
import { LatexChatLauncher } from './LatexChatLauncher'
import { LatexManuscript } from './LatexManuscript'
import { NotesPanel } from './NotesPanel'
import { ProjectQnaPane } from './ProjectQnaPane'
import {
  ProjectShortcutGuide,
  ShortcutKeytip
} from './ProjectShortcutGuide'

const LatexPdfPreview = lazy(async () => {
  const module = await import('./LatexPdfPreview')
  return { default: module.LatexPdfPreview }
})

type WorkspaceTab =
  | 'manuscript'
  | 'pdf'
  | 'actions'
  | 'qna'
  | 'notes'
  | 'files'
  | 'chats'
  | 'activity'

const latexWorkspaceTabs = new Map<string, WorkspaceTab>()
const openedPdfProjects = new Set<string>()
const latexWorkspaceCache = new Map<string, LatexWorkspace>()

export function LatexProjectWorkspace({
  project,
  selectedSessionId,
  launchTerminalRequest,
  openSessionRequest,
  onLaunchTerminalRequestHandled,
  onOpenSessionRequestHandled,
  onSessionSelected,
  onSwapPanes,
  onSelectSession,
  onChanged
}: ProjectWorkspaceProps) {
  const [tab, setTab] = useState<WorkspaceTab>(
    () => latexWorkspaceTabs.get(project.id) ?? 'manuscript'
  )
  const [pdfOpened, setPdfOpened] = useState(
    () => openedPdfProjects.has(project.id) || tab === 'pdf'
  )
  const [workspace, setWorkspace] = useState<LatexWorkspace | null>(
    () => latexWorkspaceCache.get(project.id) ?? null
  )
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)
  const [showLauncher, setShowLauncher] = useState(false)
  const [filesInitialPath, setFilesInitialPath] = useState('.')
  const [openFileRequest, setOpenFileRequest] =
    useState<ProjectFileOpenRequest | null>(null)
  const [changes, setChanges] = useState<LatexChangeSet | null>(null)
  const [inlineEdits, setInlineEdits] = useState<LatexInlineEditHistory[]>([])
  const [comments, setComments] = useState<LatexComment[]>([])
  const [loading, setLoading] = useState(
    () => !latexWorkspaceCache.has(project.id)
  )
  const [refreshingWorkspace, setRefreshingWorkspace] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [error, setError] = useState('')
  const [chatLayout, setChatLayout] = useState(() =>
    loadLatexChatLayout(project.id)
  )
  const [resizingChat, setResizingChat] = useState(false)
  const workspaceRequestRef = useRef(0)
  const workbenchRef = useRef<HTMLDivElement>(null)
  const chatResizeRef = useRef<{
    startX: number
    startWidth: number
    latestWidth: number
  } | null>(null)
  const sessions = useMemo(
    () =>
      project.sessions.filter(
        (session) =>
          !session.archived &&
          session.kind === 'latex-chat' &&
          session.latexChat?.purpose === 'writing'
      ),
    [project.sessions]
  )
  const archivedSessions = useMemo(
    () =>
      project.sessions.filter(
        (session) =>
          session.archived &&
          session.kind === 'latex-chat' &&
          session.latexChat?.purpose === 'writing'
      ),
    [project.sessions]
  )
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null
  const inlineSession =
    project.sessions.find(
      (session) =>
        !session.archived &&
        session.kind === 'latex-chat' &&
        session.latexChat?.purpose === 'inline-edit'
    ) ?? null
  const changeSession =
    inlineSession ??
    (activeSession?.latexChat?.mode === 'edit' ? activeSession : null)

  const refreshInlineEdits = useCallback(async () => {
    if (typeof window.projectConsole.latex.listInlineEdits !== 'function') {
      return
    }
    try {
      setInlineEdits(
        await window.projectConsole.latex.listInlineEdits(project.id)
      )
    } catch {
      // Editorial history is supplemental to the source editor.
    }
  }, [project.id])

  const refreshComments = useCallback(async () => {
    if (typeof window.projectConsole.latex.listComments !== 'function') return
    try {
      setComments(await window.projectConsole.latex.listComments(project.id))
    } catch {
      // Comments are supplemental to the source editor.
    }
  }, [project.id])

  function selectWorkspaceTab(nextTab: WorkspaceTab) {
    latexWorkspaceTabs.set(project.id, nextTab)
    if (nextTab === 'pdf') {
      openedPdfProjects.add(project.id)
      setPdfOpened(true)
    }
    setTab(nextTab)
  }

  const shortcutActions: ProjectShortcutAction[] = [
    {
      key: 'm',
      label: 'Manuscript',
      active: tab === 'manuscript',
      run: () => selectWorkspaceTab('manuscript')
    },
    {
      key: 'p',
      label: 'PDF',
      active: tab === 'pdf',
      run: () => selectWorkspaceTab('pdf')
    },
    {
      key: 'a',
      label: 'Actions',
      active: tab === 'actions',
      run: () => selectWorkspaceTab('actions')
    },
    {
      key: 'q',
      label: 'Q&A',
      active: tab === 'qna',
      run: () => selectWorkspaceTab('qna')
    },
    {
      key: 'n',
      label: 'Notes',
      active: tab === 'notes',
      run: () => selectWorkspaceTab('notes')
    },
    {
      key: 'f',
      label: 'Files',
      active: tab === 'files',
      run: () => selectWorkspaceTab('files')
    },
    {
      key: 'c',
      label: 'Chats',
      active: tab === 'chats',
      run: () => selectWorkspaceTab('chats')
    },
    {
      key: 'h',
      label: 'Activity',
      active: tab === 'activity',
      run: () => selectWorkspaceTab('activity')
    },
    ...(onSwapPanes
      ? [{ key: 's', label: 'Swap panes', run: onSwapPanes }]
      : [])
  ]
  const shortcutSessions = sessions.map((session) => ({
    id: session.id,
    label: session.name
  }))
  const projectShortcuts = useProjectShortcuts({
    scopeId: project.id,
    actions: shortcutActions,
    sessions: shortcutSessions,
    activeSessionId: activeSession?.id ?? null,
    onSelectSession: selectShortcutSession
  })

  const loadWorkspace = useCallback(async () => {
    const requestId = ++workspaceRequestRef.current
    const cached = latexWorkspaceCache.get(project.id) ?? null
    setLoading(cached == null)
    setRefreshingWorkspace(cached != null)
    setError('')
    setRefreshError('')
    try {
      const next = await window.projectConsole.latex.getWorkspace(project.id)
      if (requestId !== workspaceRequestRef.current) return
      latexWorkspaceCache.set(project.id, next)
      setWorkspace(next)
      setSelectedSectionId((current) =>
        current && next.sections.some((section) => section.id === current)
          ? current
          : null
      )
    } catch (caught) {
      if (requestId !== workspaceRequestRef.current) return
      const message = caught instanceof Error ? caught.message : String(caught)
      if (cached) setRefreshError(message)
      else setError(message)
    } finally {
      if (requestId === workspaceRequestRef.current) {
        setLoading(false)
        setRefreshingWorkspace(false)
      }
    }
  }, [project.id])

  useLayoutEffect(() => {
    const cached = latexWorkspaceCache.get(project.id) ?? null
    const rememberedTab = latexWorkspaceTabs.get(project.id) ?? 'manuscript'
    setTab(rememberedTab)
    setPdfOpened(openedPdfProjects.has(project.id) || rememberedTab === 'pdf')
    setWorkspace(cached)
    setLoading(cached == null)
    setRefreshingWorkspace(false)
    setError('')
    setRefreshError('')
    setChanges(null)
    setInlineEdits([])
    setComments([])
    setSelectedSectionId(null)
    setOpenFileRequest(null)
    setChatLayout(loadLatexChatLayout(project.id))
    chatResizeRef.current = null
    setResizingChat(false)
    if (!cached) void loadWorkspace()
    void refreshInlineEdits()
    void refreshComments()
    return () => {
      workspaceRequestRef.current += 1
    }
  }, [project.id, loadWorkspace, refreshInlineEdits, refreshComments])

  useEffect(() => {
    if (!resizingChat) return

    function handlePointerMove(event: PointerEvent) {
      const resize = chatResizeRef.current
      if (!resize) return
      const width = clampLatexChatWidth(
        resize.startWidth + resize.startX - event.clientX,
        workbenchRef.current?.getBoundingClientRect().width
      )
      resize.latestWidth = width
      setChatLayout((current) => ({ ...current, width }))
    }

    function finishResize() {
      const resize = chatResizeRef.current
      if (resize) {
        saveLatexChatLayout(project.id, {
          hidden: false,
          width: resize.latestWidth
        })
      }
      chatResizeRef.current = null
      setResizingChat(false)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', finishResize)
    window.addEventListener('pointercancel', finishResize)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', finishResize)
      window.removeEventListener('pointercancel', finishResize)
    }
  }, [project.id, resizingChat])

  useEffect(() => {
    if (!activeSession) return
    if (activeSession.id !== selectedSessionId) onSelectSession(activeSession.id)
    if (
      activeSession.latexChat?.scope === 'section' &&
      activeSession.latexChat.sectionId
    ) {
      setSelectedSectionId(activeSession.latexChat.sectionId)
    }
  }, [activeSession?.id])

  useEffect(() => {
    setShowLauncher(false)
  }, [project.id])

  useEffect(() => {
    if (launchTerminalRequest == null) return
    setShowLauncher(true)
    onLaunchTerminalRequestHandled(launchTerminalRequest)
  }, [launchTerminalRequest, onLaunchTerminalRequestHandled])

  useEffect(() => {
    if (openSessionRequest == null) return
    selectWorkspaceTab('manuscript')
    onOpenSessionRequestHandled(openSessionRequest)
  }, [openSessionRequest, onOpenSessionRequestHandled])

  const refreshChanges = useCallback(async () => {
    if (!changeSession) {
      setChanges(null)
      return
    }
    try {
      setChanges(await window.projectConsole.latex.changes(changeSession.id))
    } catch {
      // Change tracking is supplemental; the editor and terminal should remain usable.
    }
  }, [changeSession?.id])

  useEffect(() => {
    void refreshChanges()
    if (
      changeSession?.state !== 'running' ||
      changeSession.latexChat?.purpose === 'inline-edit'
    ) {
      return
    }
    const timer = window.setInterval(() => void refreshChanges(), 1_800)
    return () => window.clearInterval(timer)
  }, [refreshChanges, changeSession?.state])

  async function startChat(input: StartLatexChatInput) {
    const session = await window.projectConsole.latex.startChat(input)
    await onChanged()
    selectWorkspaceTab('manuscript')
    onSelectSession(session.id)
  }

  async function sendInlineEdit(
    selection: LatexSourceSelection,
    instruction: string
  ) {
    if (
      typeof window.projectConsole.latex.listInlineEdits !== 'function' ||
      typeof window.projectConsole.latex.rollbackInlineEdit !== 'function'
    ) {
      throw new Error(
        'The inline-edit interface is newer than PanePilot’s backend. Restart PanePilot once, then apply this edit again.'
      )
    }
    try {
      const edit = await window.projectConsole.latex.sendInlineEdit({
        projectId: project.id,
        selection,
        instruction
      })
      void Promise.all([onChanged(), refreshInlineEdits(), loadWorkspace()])
        .then(async () => {
          if (changeSession) {
            setChanges(
              await window.projectConsole.latex.changes(changeSession.id)
            )
          }
        })
        .catch(() => {
          // Source application already succeeded. Supplemental project state
          // can catch up on its normal refresh without delaying the editor.
        })
      return edit
    } catch (error) {
      void Promise.all([onChanged(), refreshInlineEdits()])
      throw error
    }
  }

  async function rollbackInlineEdit(editId: string) {
    const edit = await window.projectConsole.latex.rollbackInlineEdit(editId)
    await Promise.all([refreshInlineEdits(), loadWorkspace()])
    if (changeSession) {
      setChanges(await window.projectConsole.latex.changes(changeSession.id))
    }
    return edit
  }

  async function deleteInlineEdit(editId: string) {
    await window.projectConsole.latex.deleteInlineEdit(editId)
    await refreshInlineEdits()
  }

  async function createComment(selection: LatexSourceSelection, body: string) {
    if (typeof window.projectConsole.latex.createComment !== 'function') {
      throw new Error(
        'The comments interface is newer than PanePilot’s backend. Restart PanePilot once, then add the comment again.'
      )
    }
    const comment = await window.projectConsole.latex.createComment({
      projectId: project.id,
      selection,
      body
    })
    await refreshComments()
    return comment
  }

  async function deleteComment(commentId: string) {
    await window.projectConsole.latex.deleteComment(project.id, commentId)
    await refreshComments()
  }

  async function selectShortcutSession(id: string) {
    selectWorkspaceTab('manuscript')
    onSessionSelected(id)
    onSelectSession(id)
  }

  async function clearChanges() {
    if (!changeSession) return
    await window.projectConsole.latex.clearChanges(changeSession.id)
    setChanges({ sessionId: changeSession.id, capturedAt: null, files: [] })
  }

  function openContext() {
    if (!workspace) return
    setFilesInitialPath(workspace.details.contextFolder)
    selectWorkspaceTab('files')
  }

  function openFile(target: TerminalFileTarget) {
    setOpenFileRequest((current) => ({
      ...target,
      projectId: project.id,
      requestId: (current?.requestId ?? 0) + 1
    }))
    selectWorkspaceTab('files')
  }

  function updateChatLayout(next: typeof chatLayout) {
    setChatLayout(next)
    saveLatexChatLayout(project.id, next)
  }

  function beginChatResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    chatResizeRef.current = {
      startX: event.clientX,
      startWidth: chatLayout.width,
      latestWidth: chatLayout.width
    }
    setResizingChat(true)
  }

  function handleChatResizeKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    let nextWidth = chatLayout.width
    if (event.key === 'ArrowLeft') nextWidth += 24
    else if (event.key === 'ArrowRight') nextWidth -= 24
    else if (event.key === 'Home') nextWidth = MIN_LATEX_CHAT_WIDTH
    else if (event.key === 'End') nextWidth = MAX_LATEX_CHAT_WIDTH
    else return

    event.preventDefault()
    updateChatLayout({
      hidden: false,
      width: clampLatexChatWidth(
        nextWidth,
        workbenchRef.current?.getBoundingClientRect().width
      )
    })
  }

  const chatCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const session of sessions) {
      const key =
        session.latexChat?.scope === 'section'
          ? session.latexChat.sectionId ?? 'missing'
          : 'project'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return counts
  }, [sessions])

  if (loading || workspace?.details.projectId !== project.id) {
    return (
      <div className="capability-empty latex-loading">
        <LoaderCircle className="spin" size={30} />
        <h3>Mapping the manuscript</h3>
        <p>Reading the main file and resolving its section sources.</p>
      </div>
    )
  }

  if (!workspace || error) {
    return (
      <div className="capability-empty error-empty">
        <FileText size={35} />
        <h3>LaTeX workspace unavailable</h3>
        <p>{error || 'The project settings could not be loaded.'}</p>
        <button className="primary-button" onClick={() => void loadWorkspace()}>
          Try again
        </button>
      </div>
    )
  }

  return (
    <div
      className="project-workspace latex-project-workspace"
      ref={projectShortcuts.rootRef}
    >
      <nav className="workspace-tabs" aria-label="LaTeX project tools">
        <button
          className={tab === 'manuscript' ? 'active' : ''}
          onClick={() => selectWorkspaceTab('manuscript')}
        >
          <FileText size={15} /> Manuscript
          <ShortcutKeytip value="M" open={projectShortcuts.open} />
        </button>
        <button
          className={tab === 'pdf' ? 'active' : ''}
          onClick={() => selectWorkspaceTab('pdf')}
        >
          <FileType2 size={15} /> PDF Preview
          <ShortcutKeytip value="P" open={projectShortcuts.open} />
        </button>
        <button className={tab === 'actions' ? 'active' : ''} onClick={() => selectWorkspaceTab('actions')}>
          <Play size={15} /> Actions
          <ShortcutKeytip value="A" open={projectShortcuts.open} />
        </button>
        <button className={tab === 'qna' ? 'active' : ''} onClick={() => selectWorkspaceTab('qna')}>
          <MessageCircleQuestion size={15} /> Project Q&amp;A
          <ShortcutKeytip value="Q" open={projectShortcuts.open} />
        </button>
        <button className={tab === 'notes' ? 'active' : ''} onClick={() => selectWorkspaceTab('notes')}>
          <FileText size={15} /> Notes
          <ShortcutKeytip value="N" open={projectShortcuts.open} />
        </button>
        <button className={tab === 'files' ? 'active' : ''} onClick={() => selectWorkspaceTab('files')}>
          <Files size={15} /> Files
          <ShortcutKeytip value="F" open={projectShortcuts.open} />
        </button>
        <button className={tab === 'chats' ? 'active' : ''} onClick={() => selectWorkspaceTab('chats')}>
          <MessageSquareText size={15} /> Chat history
          <ShortcutKeytip value="C" open={projectShortcuts.open} />
        </button>
        <button
          className={tab === 'activity' ? 'active' : ''}
          onClick={() => selectWorkspaceTab('activity')}
        >
          <Activity size={15} /> Activity
          <ShortcutKeytip value="H" open={projectShortcuts.open} />
        </button>
        <div className="latex-tab-meta">
          <FileClock size={13} />
          <span>{workspace.details.mainFile}</span>
          {refreshingWorkspace && (
            <LoaderCircle
              className="spin latex-background-refresh"
              size={11}
              aria-label="Refreshing manuscript map"
            />
          )}
          {refreshError && (
            <span className="latex-refresh-error" title={refreshError}>
              Refresh failed
            </span>
          )}
          {chatLayout.hidden && (
            <button
              className="latex-chat-show-button"
              onClick={() =>
                updateChatLayout({ ...chatLayout, hidden: false })
              }
              title="Show the writing chat beside the manuscript or PDF"
            >
              <PanelRightOpen size={12} /> Chat
            </button>
          )}
        </div>
      </nav>

      <ProjectShortcutGuide
        open={projectShortcuts.open}
        projectName={project.name}
        actions={shortcutActions}
        sessions={shortcutSessions}
        activeSessionId={activeSession?.id ?? null}
      />

      <div
        ref={workbenchRef}
        className={`latex-workbench ${
          chatLayout.hidden ? 'chat-hidden' : 'chat-visible'
        } ${resizingChat ? 'resizing' : ''} ${
          tab === 'manuscript' || tab === 'pdf' ? '' : 'cached'
        }`}
        style={
          {
            '--latex-chat-width': `${chatLayout.width}px`
          } as CSSProperties
        }
        aria-hidden={tab !== 'manuscript' && tab !== 'pdf'}
      >
        <div className="latex-workbench-main">
          <div
            className={`workspace-panel-cache ${
              tab === 'manuscript' ? 'active' : ''
            }`}
            aria-hidden={tab !== 'manuscript'}
          >
            <LatexManuscript
              key={project.id}
              project={project}
              workspace={workspace}
              inlineEdits={inlineEdits}
              comments={comments}
              inlineRunning={inlineSession?.state === 'running'}
              selectedSectionId={selectedSectionId}
              chatCounts={chatCounts}
              changes={changes}
              onSelectSection={setSelectedSectionId}
              onOpenContext={openContext}
              onClearChanges={clearChanges}
              onWorkspaceRefresh={loadWorkspace}
              onInlineEdit={sendInlineEdit}
              onRollbackInlineEdit={rollbackInlineEdit}
              onDeleteInlineEdit={deleteInlineEdit}
              onCreateComment={createComment}
              onDeleteComment={deleteComment}
              onOpenFile={openFile}
            />
          </div>
          {pdfOpened && (
            <div
              className={`workspace-panel-cache ${
                tab === 'pdf' ? 'active' : ''
              }`}
              aria-hidden={tab !== 'pdf'}
            >
              <Suspense
                fallback={
                  <div className="latex-pdf-state" role="status">
                    <LoaderCircle className="spin" size={28} />
                    <strong>Preparing the PDF viewer</strong>
                  </div>
                }
              >
                <LatexPdfPreview
                  key={project.id}
                  projectId={project.id}
                  mainFile={workspace.details.mainFile}
                  local={project.connectionId === 'local'}
                />
              </Suspense>
            </div>
          )}
        </div>
        <div
          className="latex-agent-resizer"
          role="separator"
          aria-label="Resize writing chat"
          aria-orientation="vertical"
          aria-valuemin={MIN_LATEX_CHAT_WIDTH}
          aria-valuemax={MAX_LATEX_CHAT_WIDTH}
          aria-valuenow={chatLayout.width}
          aria-valuetext={`${chatLayout.width} pixels wide`}
          tabIndex={chatLayout.hidden ? -1 : 0}
          onPointerDown={beginChatResize}
          onKeyDown={handleChatResizeKey}
        />
        <LatexAgentPane
          key={project.id}
          sessions={sessions}
          archivedSessions={archivedSessions}
          sections={workspace.sections}
          projectFolder={project.folder}
          activeSessionId={activeSession?.id ?? null}
          onSelectSession={(id) => {
            onSessionSelected(id)
            onSelectSession(id)
          }}
          onNewChat={() => setShowLauncher(true)}
          onChanged={onChanged}
          onPromptSent={() => {
            window.setTimeout(() => void refreshChanges(), 700)
          }}
          onOpenFile={openFile}
          onHide={() =>
            updateChatLayout({ ...chatLayout, hidden: true })
          }
        />
      </div>
      <div
        className={`workspace-panel-cache ${tab === 'notes' ? 'active' : ''}`}
        aria-hidden={tab !== 'notes'}
      >
        <NotesPanel
          key={project.id}
          project={project}
          onOpenFile={openFile}
        />
      </div>
      <div
        className={`workspace-panel-cache ${tab === 'files' ? 'active' : ''}`}
        aria-hidden={tab !== 'files'}
      >
        <FilesPanel
          key={`${project.id}:${filesInitialPath}`}
          project={project}
          initialPath={filesInitialPath}
          openFileRequest={openFileRequest}
          onChanged={onChanged}
        />
      </div>
      {tab === 'actions' && (
        <ActionsPanel
          project={project}
          onChanged={onChanged}
          onOpenFile={openFile}
        />
      )}
      {tab === 'qna' && (
        <ProjectQnaPane
          project={project}
          onChanged={onChanged}
          onOpenFile={openFile}
        />
      )}
      {tab === 'chats' && <ChatHistoryPanel project={project} />}
      {tab === 'activity' && <HistoryPanel project={project} />}

      {showLauncher && (
        <LatexChatLauncher
          projectId={project.id}
          sections={workspace.sections}
          initialSectionId={selectedSectionId}
          onClose={() => setShowLauncher(false)}
          onStart={startChat}
        />
      )}
    </div>
  )
}
