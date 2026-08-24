import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState
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
  Play,
  Plus
} from 'lucide-react'
import type {
  LatexChangeSet,
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
  const [workspace, setWorkspace] = useState<LatexWorkspace | null>(null)
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null)
  const [showLauncher, setShowLauncher] = useState(false)
  const [filesInitialPath, setFilesInitialPath] = useState('.')
  const [openFileRequest, setOpenFileRequest] =
    useState<ProjectFileOpenRequest | null>(null)
  const [changes, setChanges] = useState<LatexChangeSet | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sessions = useMemo(
    () =>
      project.sessions.filter(
        (session) =>
          !session.archived &&
          session.kind === 'latex-chat' &&
          session.latexChat != null
      ),
    [project.sessions]
  )
  const archivedSessions = useMemo(
    () =>
      project.sessions.filter(
        (session) =>
          session.archived &&
          session.kind === 'latex-chat' &&
          session.latexChat != null
      ),
    [project.sessions]
  )
  const activeSession =
    sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null

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
    setError('')
    try {
      const next = await window.projectConsole.latex.getWorkspace(project.id)
      setWorkspace(next)
      setSelectedSectionId((current) =>
        current && next.sections.some((section) => section.id === current)
          ? current
          : null
      )
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [project.id])

  useEffect(() => {
    const rememberedTab = latexWorkspaceTabs.get(project.id) ?? 'manuscript'
    setTab(rememberedTab)
    setPdfOpened(openedPdfProjects.has(project.id) || rememberedTab === 'pdf')
    setLoading(true)
    setWorkspace(null)
    setChanges(null)
    setSelectedSectionId(null)
    setOpenFileRequest(null)
    void loadWorkspace()
  }, [project.id, loadWorkspace])

  useEffect(() => {
    if (!activeSession) return
    if (activeSession.id !== selectedSessionId) onSelectSession(activeSession.id)
    if (
      activeSession.latexChat?.scope === 'section' &&
      activeSession.latexChat.sectionId
    ) {
      setSelectedSectionId(activeSession.latexChat.sectionId)
    }
    void window.projectConsole.terminals.acknowledge(activeSession.id).then(onChanged)
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
    if (!activeSession?.latexChat || activeSession.latexChat.mode !== 'edit') {
      setChanges(null)
      return
    }
    try {
      setChanges(await window.projectConsole.latex.changes(activeSession.id))
    } catch {
      // Change tracking is supplemental; the editor and terminal should remain usable.
    }
  }, [activeSession?.id, activeSession?.latexChat?.mode])

  useEffect(() => {
    void refreshChanges()
    if (activeSession?.state !== 'running') return
    const timer = window.setInterval(() => void refreshChanges(), 1_800)
    return () => window.clearInterval(timer)
  }, [refreshChanges, activeSession?.state])

  async function startChat(input: StartLatexChatInput) {
    const session = await window.projectConsole.latex.startChat(input)
    await onChanged()
    selectWorkspaceTab('manuscript')
    onSelectSession(session.id)
  }

  async function selectShortcutSession(id: string) {
    selectWorkspaceTab('manuscript')
    onSessionSelected(id)
    onSelectSession(id)
    await window.projectConsole.terminals.acknowledge(id)
    await onChanged()
  }

  async function clearChanges() {
    if (!activeSession) return
    await window.projectConsole.latex.clearChanges(activeSession.id)
    setChanges({ sessionId: activeSession.id, capturedAt: null, files: [] })
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
          <button onClick={() => setShowLauncher(true)}>
            <Plus size={12} /> Chat
          </button>
        </div>
      </nav>

      <ProjectShortcutGuide
        open={projectShortcuts.open}
        projectName={project.name}
        actions={shortcutActions}
        sessions={shortcutSessions}
        activeSessionId={activeSession?.id ?? null}
      />

      {tab === 'manuscript' && (
        <div className="latex-workbench">
          <LatexManuscript
            project={project}
            workspace={workspace}
            selectedSectionId={selectedSectionId}
            chatCounts={chatCounts}
            changes={changes}
            onSelectSection={setSelectedSectionId}
            onOpenContext={openContext}
            onClearChanges={clearChanges}
            onWorkspaceRefresh={loadWorkspace}
          />
          <LatexAgentPane
            sessions={sessions}
            archivedSessions={archivedSessions}
            sections={workspace.sections}
            projectFolder={project.folder}
            activeSessionId={activeSession?.id ?? null}
            onSelectSession={(id) => {
              onSessionSelected(id)
              onSelectSession(id)
              void window.projectConsole.terminals.acknowledge(id).then(onChanged)
            }}
            onNewChat={() => setShowLauncher(true)}
            onChanged={onChanged}
            onPromptSent={() => {
              window.setTimeout(() => void refreshChanges(), 700)
            }}
            onOpenFile={openFile}
          />
        </div>
      )}
      {pdfOpened && (
        <div
          className={`workspace-panel-cache ${tab === 'pdf' ? 'active' : ''}`}
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
