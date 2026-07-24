import { randomUUID } from 'node:crypto'
import { join, posix } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Activity,
  AgentState,
  Connection,
  LatexChatAttachment,
  LatexChatMode,
  LatexChatScope,
  LatexProjectDetails,
  LatexSection,
  LaunchProfile,
  Project,
  ProjectType,
  TerminalBackend,
  TerminalSession
} from '../shared/types'
import type {
  PanePilotTmuxLatexMetadata,
  PanePilotTmuxMetadata
} from './tmux-metadata'

const OUTPUT_LIMIT = 512 * 1024
const STATE_PRIORITY: AgentState[] = [
  'needs-input',
  'needs-attention',
  'running',
  'response-ready',
  'idle',
  'error',
  'completed'
]

type ConnectionRow = {
  id: string
  kind: 'local' | 'ssh'
  name: string
  ssh_alias: string | null
}

type ProjectRow = {
  id: string
  type: ProjectType
  name: string
  connection_id: string
  folder: string
  repository_url: string | null
  state: AgentState
  archived: number
  created_at: string
  updated_at: string
}

type LatexProjectRow = {
  project_id: string
  main_file: string
  overleaf_url: string | null
  context_folder: string
}

type LatexSectionRow = {
  id: string
  project_id: string
  title: string
  level: number
  source_file: string
  start_line: number
  end_line: number
  ordinal: number
  missing: number
  updated_at: string
}

type LatexChatRow = {
  terminal_session_id: string
  project_id: string
  scope: LatexChatScope
  section_id: string | null
  mode: LatexChatMode
  created_at: string
}

export interface ParsedLatexSection {
  title: string
  level: number
  sourceFile: string
  startLine: number
  endLine: number
  ordinal: number
}

export interface LatexEditSnapshot {
  relativePath: string
  content: string
  createdAt: string
}

type SessionRow = {
  id: string
  project_id: string
  name: string
  profile: LaunchProfile
  provider_session_id: string | null
  provider_session_name: string | null
  custom_command: string | null
  backend: TerminalBackend
  tmux_name: string | null
  state: AgentState
  dangerous_mode: number
  archived: number
  pinned: number
  output: string
  created_at: string
  updated_at: string
}

type ActivityRow = {
  id: string
  project_id: string
  session_id: string | null
  kind: string
  message: string
  created_at: string
}

type PortForwardRow = {
  id: string
  connection_id: string
  name: string
  bind_address: '127.0.0.1'
  local_port: number
  remote_host: string
  remote_port: number
  created_at: string
}

export interface StoredPortForward {
  id: string
  connectionId: string
  name: string
  bindAddress: '127.0.0.1'
  localPort: number
  remoteHost: string
  remotePort: number
  createdAt: string
}

export interface DiscoveredTmuxSessionUpsert {
  session: TerminalSession
  changed: boolean
}

function now(): string {
  return new Date().toISOString()
}

function mapConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    sshAlias: row.ssh_alias
  }
}

function mapLatexProject(row: LatexProjectRow): LatexProjectDetails {
  return {
    projectId: row.project_id,
    mainFile: row.main_file,
    overleafUrl: row.overleaf_url,
    contextFolder: row.context_folder
  }
}

function mapLatexSection(row: LatexSectionRow): LatexSection {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    level: row.level,
    sourceFile: row.source_file,
    startLine: row.start_line,
    endLine: row.end_line,
    ordinal: row.ordinal
  }
}

function mapLatexChat(row: LatexChatRow): LatexChatAttachment {
  return {
    terminalSessionId: row.terminal_session_id,
    projectId: row.project_id,
    scope: row.scope,
    sectionId: row.section_id,
    mode: row.mode,
    createdAt: row.created_at
  }
}

function mapSession(
  row: SessionRow,
  latexChat: LatexChatAttachment | null = null
): TerminalSession {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    profile: row.profile,
    providerSessionId: row.provider_session_id,
    providerSessionName: row.provider_session_name,
    customCommand: row.custom_command,
    backend: row.backend,
    tmuxName: row.tmux_name,
    state: row.state,
    dangerousMode: Boolean(row.dangerous_mode),
    archived: Boolean(row.archived),
    pinned: Boolean(row.pinned),
    output: row.output,
    latexChat,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function mapPortForward(row: PortForwardRow): StoredPortForward {
  return {
    id: row.id,
    connectionId: row.connection_id,
    name: row.name,
    bindAddress: row.bind_address,
    localPort: row.local_port,
    remoteHost: row.remote_host,
    remotePort: row.remote_port,
    createdAt: row.created_at
  }
}

function mapActivity(row: ActivityRow): Activity {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    kind: row.kind,
    message: row.message,
    createdAt: row.created_at
  }
}

export class Store {
  private readonly db: DatabaseSync

  constructor(appDataPath: string) {
    this.db = new DatabaseSync(join(appDataPath, 'project-console.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS connections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('local', 'ssh')),
        name TEXT NOT NULL,
        ssh_alias TEXT
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL DEFAULT 'terminal',
        name TEXT NOT NULL,
        connection_id TEXT NOT NULL REFERENCES connections(id),
        folder TEXT NOT NULL,
        repository_url TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        archived INTEGER NOT NULL DEFAULT 0,
        parent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS terminal_sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        profile TEXT NOT NULL,
        provider_session_id TEXT,
        provider_session_name TEXT,
        custom_command TEXT,
        backend TEXT NOT NULL,
        tmux_name TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        dangerous_mode INTEGER NOT NULL DEFAULT 0,
        tmux_metadata_version INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        output TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES terminal_sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id),
        provider TEXT NOT NULL,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS port_forwards (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id),
        name TEXT NOT NULL,
        bind_address TEXT NOT NULL DEFAULT '127.0.0.1',
        local_port INTEGER NOT NULL,
        remote_host TEXT NOT NULL,
        remote_port INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS latex_projects (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        main_file TEXT NOT NULL DEFAULT 'main.tex',
        overleaf_url TEXT,
        context_folder TEXT NOT NULL DEFAULT 'context'
      );

      CREATE TABLE IF NOT EXISTS latex_sections (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        level INTEGER NOT NULL,
        source_file TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        missing INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS latex_chat_sessions (
        terminal_session_id TEXT PRIMARY KEY REFERENCES terminal_sessions(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        scope TEXT NOT NULL CHECK (scope IN ('project', 'section')),
        section_id TEXT REFERENCES latex_sections(id),
        mode TEXT NOT NULL CHECK (mode IN ('ask', 'edit')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS latex_edit_snapshots (
        terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (terminal_session_id, relative_path)
      );
    `)

    this.ensureColumn('connections', 'ssh_alias', 'TEXT')
    this.ensureColumn('projects', 'created_at', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('projects', 'archived', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('terminal_sessions', 'name', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('terminal_sessions', 'provider_session_id', 'TEXT')
    this.ensureColumn('terminal_sessions', 'provider_session_name', 'TEXT')
    this.ensureColumn('terminal_sessions', 'custom_command', 'TEXT')
    this.ensureColumn('terminal_sessions', 'tmux_name', 'TEXT')
    this.ensureColumn('terminal_sessions', 'dangerous_mode', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn(
      'terminal_sessions',
      'tmux_metadata_version',
      'INTEGER NOT NULL DEFAULT 0'
    )
    this.ensureColumn('terminal_sessions', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('activities', 'session_id', 'TEXT')
    this.ensureColumn('activities', 'message', `TEXT NOT NULL DEFAULT ''`)

    const connectionColumns = this.tableColumns('connections')
    const sessionColumns = this.tableColumns('terminal_sessions')
    const activityColumns = this.tableColumns('activities')
    if (connectionColumns.has('host')) {
      this.db.exec(`UPDATE connections SET ssh_alias = host WHERE ssh_alias IS NULL AND kind = 'ssh'`)
    }
    if (sessionColumns.has('label')) {
      this.db.exec(`UPDATE terminal_sessions SET name = label WHERE name = ''`)
    }
    if (sessionColumns.has('command')) {
      this.db.exec(
        `UPDATE terminal_sessions SET custom_command = command WHERE custom_command IS NULL`
      )
    }
    if (sessionColumns.has('backend_name')) {
      this.db.exec(`UPDATE terminal_sessions SET tmux_name = backend_name WHERE tmux_name IS NULL`)
    }
    if (sessionColumns.has('dangerous')) {
      this.db.exec(
        `UPDATE terminal_sessions SET dangerous_mode = dangerous WHERE dangerous_mode = 0`
      )
    }
    if (activityColumns.has('content')) {
      this.db.exec(`UPDATE activities SET message = content WHERE message = ''`)
    }

    this.db.exec(`
      UPDATE projects SET created_at = updated_at WHERE created_at = '';
      CREATE INDEX IF NOT EXISTS terminal_sessions_project_idx
        ON terminal_sessions(project_id, archived);
      CREATE INDEX IF NOT EXISTS terminal_sessions_provider_idx
        ON terminal_sessions(provider_session_id);
      CREATE INDEX IF NOT EXISTS terminal_sessions_provider_name_idx
        ON terminal_sessions(provider_session_name);
      CREATE INDEX IF NOT EXISTS activities_project_idx
        ON activities(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS port_forwards_connection_idx
        ON port_forwards(connection_id, created_at);
      CREATE INDEX IF NOT EXISTS latex_sections_project_idx
        ON latex_sections(project_id, missing, ordinal);
      CREATE INDEX IF NOT EXISTS latex_chat_sessions_project_idx
        ON latex_chat_sessions(project_id, scope, section_id);

      UPDATE projects SET parent_id = NULL WHERE parent_id IS NOT NULL;
      PRAGMA user_version = 6;
    `)
  }

  private tableColumns(table: string): Set<string> {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    return new Set(rows.map((row) => row.name))
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (this.tableColumns(table).has(column)) return
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }

  syncConnections(sshAliases: string[]): void {
    const upsert = this.db.prepare(`
      INSERT INTO connections (id, kind, name, ssh_alias)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, ssh_alias = excluded.ssh_alias
    `)
    this.inTransaction(() => {
      upsert.run('local', 'local', 'This Mac', null)
      for (const alias of sshAliases) {
        upsert.run(`ssh:${alias}`, 'ssh', alias, alias)
      }
    })
  }

  listConnections(): Connection[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, name, ssh_alias
         FROM connections
         ORDER BY CASE kind WHEN 'local' THEN 0 ELSE 1 END, name COLLATE NOCASE`
      )
      .all() as ConnectionRow[]
    return rows.map(mapConnection)
  }

  getConnection(id: string): Connection | null {
    const row = this.db
      .prepare('SELECT id, kind, name, ssh_alias FROM connections WHERE id = ?')
      .get(id) as ConnectionRow | undefined
    return row ? mapConnection(row) : null
  }

  createProject(input: {
    type: ProjectType
    name: string
    connectionId: string
    folder: string
    repositoryUrl: string | null
    latex?: {
      mainFile: string
      overleafUrl: string | null
      contextFolder: string
    }
  }): Project {
    const id = randomUUID()
    const timestamp = now()
    this.inTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects
           (id, type, name, connection_id, folder, repository_url, state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'idle', ?, ?)`
        )
        .run(
          id,
          input.type,
          input.name,
          input.connectionId,
          input.folder,
          input.repositoryUrl,
          timestamp,
          timestamp
        )
      if (input.type === 'latex') {
        if (!input.latex) throw new Error('LaTeX project settings are required.')
        this.db
          .prepare(
            `INSERT INTO latex_projects
             (project_id, main_file, overleaf_url, context_folder)
             VALUES (?, ?, ?, ?)`
          )
          .run(
            id,
            input.latex.mainFile,
            input.latex.overleafUrl,
            input.latex.contextFolder
          )
      }
    })
    this.addActivity(id, null, 'project-created', `Created project in ${input.folder}`)
    return this.getProject(id)!
  }

  updateProjectRepository(id: string, repositoryUrl: string | null): void {
    const project = this.getProject(id)
    if (!project) throw new Error('Project not found.')
    if (project.repositoryUrl === repositoryUrl) return
    this.db
      .prepare('UPDATE projects SET repository_url = ?, updated_at = ? WHERE id = ?')
      .run(repositoryUrl, now(), id)
    this.addActivity(
      id,
      null,
      'repository-updated',
      repositoryUrl ? 'Updated the project repository link' : 'Removed the project repository link'
    )
  }

  renameProject(id: string, name: string): void {
    const cleaned = name.trim()
    const project = this.getProject(id)
    if (!project) throw new Error('Project not found.')
    if (!cleaned) throw new Error('Project name cannot be empty.')
    if (cleaned === project.name) return
    this.db
      .prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?')
      .run(cleaned, now(), id)
    this.addActivity(id, null, 'project-renamed', `Renamed project to ${cleaned}`)
  }

  archiveProject(id: string, archived: boolean): void {
    const project = this.getProject(id)
    if (!project) throw new Error('Project not found.')
    if (project.archived === archived) return
    if (
      archived &&
      project.sessions.some((session) => !['completed', 'error'].includes(session.state))
    ) {
      throw new Error('Stop every running terminal or chat before archiving this project.')
    }
    this.db
      .prepare('UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, now(), id)
    this.addActivity(
      id,
      null,
      archived ? 'project-archived' : 'project-restored',
      `${archived ? 'Archived' : 'Restored'} project ${project.name}`
    )
  }

  getProject(id: string): Project | null {
    const row = this.db
      .prepare(
        `SELECT id, type, name, connection_id, folder, repository_url, state, archived,
                created_at, updated_at
         FROM projects WHERE id = ?`
      )
      .get(id) as ProjectRow | undefined
    if (!row) return null
    return this.hydrateProject(row)
  }

  listProjects(): Project[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, name, connection_id, folder, repository_url, state, archived,
                created_at, updated_at
         FROM projects ORDER BY updated_at DESC`
      )
      .all() as ProjectRow[]
    return rows.map((row) => this.hydrateProject(row))
  }

  getLatexProject(projectId: string): LatexProjectDetails | null {
    const row = this.db
      .prepare(
        `SELECT project_id, main_file, overleaf_url, context_folder
         FROM latex_projects WHERE project_id = ?`
      )
      .get(projectId) as LatexProjectRow | undefined
    return row ? mapLatexProject(row) : null
  }

  updateLatexProject(
    projectId: string,
    input: {
      mainFile: string
      overleafUrl: string | null
      contextFolder: string
    }
  ): void {
    const project = this.getProject(projectId)
    if (!project || project.type !== 'latex' || !project.latex) {
      throw new Error('LaTeX project not found.')
    }
    this.db
      .prepare(
        `UPDATE latex_projects
         SET main_file = ?, overleaf_url = ?, context_folder = ?
         WHERE project_id = ?`
      )
      .run(input.mainFile, input.overleafUrl, input.contextFolder, projectId)
    this.addActivity(projectId, null, 'latex-settings-updated', 'Updated LaTeX project settings')
  }

  syncLatexSections(
    projectId: string,
    parsedSections: ParsedLatexSection[]
  ): LatexSection[] {
    const existing = this.db
      .prepare(
        `SELECT id, project_id, title, level, source_file, start_line, end_line,
                ordinal, missing, updated_at
         FROM latex_sections WHERE project_id = ? ORDER BY ordinal`
      )
      .all(projectId) as LatexSectionRow[]
    const available = new Set(existing.map((row) => row.id))
    const timestamp = now()

    this.inTransaction(() => {
      this.db
        .prepare('UPDATE latex_sections SET missing = 1, updated_at = ? WHERE project_id = ?')
        .run(timestamp, projectId)
      for (const section of parsedSections) {
        const exact = existing.find(
          (row) =>
            available.has(row.id) &&
            row.source_file === section.sourceFile &&
            row.title === section.title &&
            row.level === section.level
        )
        const positional =
          exact ??
          existing.find(
            (row) =>
              available.has(row.id) &&
              row.source_file === section.sourceFile &&
              row.ordinal === section.ordinal
          )
        const id = positional?.id ?? randomUUID()
        available.delete(id)
        this.db
          .prepare(
            `INSERT INTO latex_sections
             (id, project_id, title, level, source_file, start_line, end_line,
              ordinal, missing, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               level = excluded.level,
               source_file = excluded.source_file,
               start_line = excluded.start_line,
               end_line = excluded.end_line,
               ordinal = excluded.ordinal,
               missing = 0,
               updated_at = excluded.updated_at`
          )
          .run(
            id,
            projectId,
            section.title,
            section.level,
            section.sourceFile,
            section.startLine,
            section.endLine,
            section.ordinal,
            timestamp
          )
      }
    })
    return this.listLatexSections(projectId)
  }

  listLatexSections(projectId: string): LatexSection[] {
    const rows = this.db
      .prepare(
        `SELECT id, project_id, title, level, source_file, start_line, end_line,
                ordinal, missing, updated_at
         FROM latex_sections
         WHERE project_id = ? AND missing = 0
         ORDER BY ordinal`
      )
      .all(projectId) as LatexSectionRow[]
    return rows.map(mapLatexSection)
  }

  getLatexSection(id: string): LatexSection | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, title, level, source_file, start_line, end_line,
                ordinal, missing, updated_at
         FROM latex_sections WHERE id = ? AND missing = 0`
      )
      .get(id) as LatexSectionRow | undefined
    return row ? mapLatexSection(row) : null
  }

  attachLatexChat(
    terminalSessionId: string,
    input: {
      projectId: string
      scope: LatexChatScope
      sectionId: string | null
      mode: LatexChatMode
    }
  ): LatexChatAttachment {
    const session = this.getSession(terminalSessionId)
    const project = this.getProject(input.projectId)
    if (!session || session.projectId !== input.projectId) {
      throw new Error('The terminal does not belong to this LaTeX project.')
    }
    if (!project || project.type !== 'latex') throw new Error('LaTeX project not found.')
    if (input.scope === 'section') {
      const section = input.sectionId ? this.getLatexSection(input.sectionId) : null
      if (!section || section.projectId !== input.projectId) {
        throw new Error('Choose a section from this LaTeX project.')
      }
    }
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO latex_chat_sessions
         (terminal_session_id, project_id, scope, section_id, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        terminalSessionId,
        input.projectId,
        input.scope,
        input.scope === 'section' ? input.sectionId : null,
        input.mode,
        timestamp
      )
    this.addActivity(
      input.projectId,
      terminalSessionId,
      'latex-chat-attached',
      `Attached ${session.name} to ${input.scope === 'project' ? 'the project' : 'a section'} in ${input.mode} mode`
    )
    return this.getLatexChat(terminalSessionId)!
  }

  getLatexChat(terminalSessionId: string): LatexChatAttachment | null {
    const row = this.db
      .prepare(
        `SELECT terminal_session_id, project_id, scope, section_id, mode, created_at
         FROM latex_chat_sessions WHERE terminal_session_id = ?`
      )
      .get(terminalSessionId) as LatexChatRow | undefined
    return row ? mapLatexChat(row) : null
  }

  setLatexChatMode(terminalSessionId: string, mode: LatexChatMode): void {
    const chat = this.getLatexChat(terminalSessionId)
    if (!chat) throw new Error('LaTeX chat not found.')
    if (chat.mode === mode) return
    this.db
      .prepare('UPDATE latex_chat_sessions SET mode = ? WHERE terminal_session_id = ?')
      .run(mode, terminalSessionId)
    this.addActivity(
      chat.projectId,
      terminalSessionId,
      'latex-chat-mode-changed',
      `Changed the chat to ${mode === 'ask' ? 'Ask' : 'Edit'} mode`
    )
  }

  replaceLatexSnapshots(
    terminalSessionId: string,
    files: Record<string, string>
  ): void {
    const timestamp = now()
    const insert = this.db.prepare(
      `INSERT INTO latex_edit_snapshots
       (terminal_session_id, relative_path, content, created_at)
       VALUES (?, ?, ?, ?)`
    )
    this.inTransaction(() => {
      this.db
        .prepare('DELETE FROM latex_edit_snapshots WHERE terminal_session_id = ?')
        .run(terminalSessionId)
      for (const [relativePath, content] of Object.entries(files)) {
        insert.run(terminalSessionId, relativePath, content, timestamp)
      }
    })
  }

  getLatexSnapshots(terminalSessionId: string): LatexEditSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT relative_path, content, created_at
         FROM latex_edit_snapshots
         WHERE terminal_session_id = ?
         ORDER BY relative_path`
      )
      .all(terminalSessionId) as Array<{
      relative_path: string
      content: string
      created_at: string
    }>
    return rows.map((row) => ({
      relativePath: row.relative_path,
      content: row.content,
      createdAt: row.created_at
    }))
  }

  clearLatexSnapshots(terminalSessionId: string): void {
    this.db
      .prepare('DELETE FROM latex_edit_snapshots WHERE terminal_session_id = ?')
      .run(terminalSessionId)
  }

  private hydrateProject(row: ProjectRow): Project {
    const latexChatRows = this.db
      .prepare(
        `SELECT terminal_session_id, project_id, scope, section_id, mode, created_at
         FROM latex_chat_sessions WHERE project_id = ?`
      )
      .all(row.id) as LatexChatRow[]
    const latexChats = new Map(
      latexChatRows.map((chat) => [chat.terminal_session_id, mapLatexChat(chat)])
    )
    const sessions = (
      this.db
        .prepare(
          `SELECT id, project_id, name, profile, provider_session_id, provider_session_name,
                  custom_command, backend, tmux_name, state,
                  dangerous_mode, archived, pinned, output, created_at, updated_at
           FROM terminal_sessions WHERE project_id = ? ORDER BY created_at`
        )
        .all(row.id) as SessionRow[]
    ).map((session) => mapSession(session, latexChats.get(session.id) ?? null))
    const activities = (
      this.db
        .prepare(
          `SELECT id, project_id, session_id, kind, message, created_at
           FROM activities WHERE project_id = ? ORDER BY created_at DESC LIMIT 100`
        )
        .all(row.id) as ActivityRow[]
    ).map(mapActivity)

    return {
      id: row.id,
      type: row.type,
      name: row.name,
      connectionId: row.connection_id,
      folder: row.folder,
      repositoryUrl: row.repository_url,
      latex: this.getLatexProject(row.id),
      state: row.state,
      archived: Boolean(row.archived),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sessions,
      activities
    }
  }

  createSession(input: {
    projectId: string
    name: string
    profile: LaunchProfile
    providerSessionName: string | null
    customCommand: string | null
    backend: TerminalBackend
    tmuxName: string | null
    dangerousMode: boolean
  }): TerminalSession {
    const id = randomUUID()
    const timestamp = now()
    if (this.tableColumns('terminal_sessions').has('label')) {
      this.db
        .prepare(
          `INSERT INTO terminal_sessions
           (id, project_id, name, label, profile, provider_session_name, custom_command, command,
            backend, tmux_name, backend_name, state, dangerous_mode, dangerous,
            tmux_metadata_version, archived, pinned, output,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, ?, 0, 0, '', ?, ?)`
        )
        .run(
          id,
          input.projectId,
          input.name,
          input.name,
          input.profile,
          input.providerSessionName,
          input.customCommand,
          input.customCommand,
          input.backend,
          input.tmuxName,
          input.tmuxName,
          input.dangerousMode ? 1 : 0,
          input.dangerousMode ? 1 : 0,
          input.backend === 'tmux' ? 1 : 0,
          timestamp,
          timestamp
        )
    } else {
      this.db
        .prepare(
          `INSERT INTO terminal_sessions
           (id, project_id, name, profile, provider_session_name, custom_command, backend, tmux_name, state,
            dangerous_mode, tmux_metadata_version, archived, pinned, output, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, 0, 0, '', ?, ?)`
        )
        .run(
          id,
          input.projectId,
          input.name,
          input.profile,
          input.providerSessionName,
          input.customCommand,
          input.backend,
          input.tmuxName,
          input.dangerousMode ? 1 : 0,
          input.backend === 'tmux' ? 1 : 0,
          timestamp,
          timestamp
        )
    }
    this.addActivity(
      input.projectId,
      id,
      'terminal-created',
      `${input.name} started with the ${input.profile} profile${input.dangerousMode ? ' (permission checks disabled)' : ''}`
    )
    return this.getSession(id)!
  }

  upsertDiscoveredTmuxSession(
    projectId: string,
    name: string,
    metadata: PanePilotTmuxMetadata
  ): DiscoveredTmuxSessionUpsert | null {
    const project = this.getProject(projectId)
    if (
      !project ||
      !name.trim() ||
      name.length > 80 ||
      /[:\u0000-\u001f\u007f]/.test(name)
    ) {
      return null
    }
    const existing = this.getSession(metadata.terminalId)
    if (existing && existing.projectId !== projectId) return null

    let providerSessionId = metadata.providerSessionId
    if (providerSessionId) {
      const duplicate = this.db
        .prepare(
          `SELECT ts.id
           FROM terminal_sessions ts
           JOIN projects owner ON owner.id = ts.project_id
           WHERE owner.connection_id = ?
             AND ts.provider_session_id = ?
             AND ts.id <> ?`
        )
        .get(project.connectionId, providerSessionId, metadata.terminalId) as
        | { id: string }
        | undefined
      if (duplicate) providerSessionId = null
    }

    const timestamp = now()
    if (existing) {
      const nextProviderSessionId =
        existing.providerSessionId ?? providerSessionId
      const nextProviderSessionName =
        existing.providerSessionName ?? metadata.providerSessionName
      const shouldReactivate =
        existing.state === 'completed' || existing.state === 'error'
      const changed =
        existing.name !== name ||
        existing.profile !== metadata.profile ||
        existing.tmuxName !== name ||
        existing.dangerousMode !== metadata.dangerousMode ||
        existing.providerSessionId !== nextProviderSessionId ||
        existing.providerSessionName !== nextProviderSessionName ||
        existing.archived ||
        shouldReactivate ||
        this.getSessionTmuxMetadataVersion(existing.id) !== 1
      if (!changed) return { session: existing, changed: false }

      if (this.tableColumns('terminal_sessions').has('label')) {
        this.db
          .prepare(
            `UPDATE terminal_sessions
             SET name = ?, label = ?, profile = ?, provider_session_id = ?,
                 provider_session_name = ?, backend = 'tmux', tmux_name = ?,
                 backend_name = ?, dangerous_mode = ?, dangerous = ?,
                 tmux_metadata_version = 1, archived = 0,
                 state = CASE WHEN state IN ('completed', 'error') THEN 'idle' ELSE state END,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(
            name,
            name,
            metadata.profile,
            nextProviderSessionId,
            nextProviderSessionName,
            name,
            name,
            metadata.dangerousMode ? 1 : 0,
            metadata.dangerousMode ? 1 : 0,
            timestamp,
            existing.id
          )
      } else {
        this.db
          .prepare(
            `UPDATE terminal_sessions
             SET name = ?, profile = ?, provider_session_id = ?,
                 provider_session_name = ?, backend = 'tmux', tmux_name = ?,
                 dangerous_mode = ?, tmux_metadata_version = 1, archived = 0,
                 state = CASE WHEN state IN ('completed', 'error') THEN 'idle' ELSE state END,
                 updated_at = ?
             WHERE id = ?`
          )
          .run(
            name,
            metadata.profile,
            nextProviderSessionId,
            nextProviderSessionName,
            name,
            metadata.dangerousMode ? 1 : 0,
            timestamp,
            existing.id
          )
      }
      if (shouldReactivate) {
        this.addActivity(
          projectId,
          existing.id,
          'remote-terminal-rediscovered',
          `Rediscovered running tmux session ${name}`
        )
      }
      this.updateProjectState(projectId)
      return { session: this.getSession(existing.id)!, changed: true }
    }

    if (this.tableColumns('terminal_sessions').has('label')) {
      this.db
        .prepare(
          `INSERT INTO terminal_sessions
           (id, project_id, name, label, profile, provider_session_id,
            provider_session_name, custom_command, command, backend, tmux_name,
            backend_name, state, dangerous_mode, dangerous, tmux_metadata_version,
            archived, pinned, output, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'tmux', ?, ?, 'idle', ?, ?, 1, 0, 0, '', ?, ?)`
        )
        .run(
          metadata.terminalId,
          projectId,
          name,
          name,
          metadata.profile,
          providerSessionId,
          metadata.providerSessionName,
          name,
          name,
          metadata.dangerousMode ? 1 : 0,
          metadata.dangerousMode ? 1 : 0,
          metadata.createdAt,
          timestamp
        )
    } else {
      this.db
        .prepare(
          `INSERT INTO terminal_sessions
           (id, project_id, name, profile, provider_session_id,
            provider_session_name, custom_command, backend, tmux_name, state,
            dangerous_mode, tmux_metadata_version, archived, pinned, output,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'tmux', ?, 'idle', ?, 1, 0, 0, '', ?, ?)`
        )
        .run(
          metadata.terminalId,
          projectId,
          name,
          metadata.profile,
          providerSessionId,
          metadata.providerSessionName,
          name,
          metadata.dangerousMode ? 1 : 0,
          metadata.createdAt,
          timestamp
        )
    }
    this.addActivity(
      projectId,
      metadata.terminalId,
      'remote-terminal-discovered',
      `Discovered running tmux session ${name}`
    )
    this.updateProjectState(projectId)
    return { session: this.getSession(metadata.terminalId)!, changed: true }
  }

  upsertDiscoveredLatexChat(
    terminalSessionId: string,
    projectId: string,
    metadata: PanePilotTmuxLatexMetadata
  ): boolean {
    const project = this.getProject(projectId)
    const session = this.getSession(terminalSessionId)
    if (
      !project ||
      project.type !== 'latex' ||
      !session ||
      session.projectId !== projectId
    ) {
      return false
    }

    let sectionId: string | null = null
    if (metadata.scope === 'section') {
      const rawSource = metadata.sectionSource?.trim() ?? ''
      const sourceFile = posix.normalize(rawSource).replace(/^\.\//, '')
      const title = metadata.sectionTitle?.trim() ?? ''
      if (
        !rawSource ||
        !title ||
        title.length > 1_024 ||
        /[\u0000-\u001f\u007f]/.test(title) ||
        sourceFile === '..' ||
        sourceFile.startsWith('../') ||
        sourceFile.startsWith('/') ||
        metadata.sectionLevel == null ||
        metadata.sectionLevel < 0 ||
        metadata.sectionLevel > 6
      ) {
        return false
      }
      const matching = this.listLatexSections(projectId).find(
        (section) =>
          section.sourceFile === sourceFile && section.title === title
      )
      if (matching) {
        sectionId = matching.id
      } else {
        const desiredId = metadata.sectionId ?? randomUUID()
        const collision = this.db
          .prepare(
            `SELECT project_id, source_file, title
             FROM latex_sections WHERE id = ?`
          )
          .get(desiredId) as
          | { project_id: string; source_file: string; title: string }
          | undefined
        sectionId =
          collision &&
          (collision.project_id !== projectId ||
            collision.source_file !== sourceFile ||
            collision.title !== title)
            ? randomUUID()
            : desiredId
        const ordinalRow = this.db
          .prepare(
            'SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM latex_sections WHERE project_id = ?'
          )
          .get(projectId) as { ordinal: number }
        this.db
          .prepare(
            `INSERT INTO latex_sections
             (id, project_id, title, level, source_file, start_line, end_line,
              ordinal, missing, updated_at)
             VALUES (?, ?, ?, ?, ?, 1, 1, ?, 0, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               level = excluded.level,
               source_file = excluded.source_file,
               missing = 0,
               updated_at = excluded.updated_at`
          )
          .run(
            sectionId,
            projectId,
            title,
            metadata.sectionLevel,
            sourceFile,
            ordinalRow.ordinal,
            now()
          )
      }
    }

    const existing = this.getLatexChat(terminalSessionId)
    if (
      existing?.scope === metadata.scope &&
      existing.mode === metadata.mode &&
      existing.sectionId === sectionId
    ) {
      return false
    }
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO latex_chat_sessions
         (terminal_session_id, project_id, scope, section_id, mode, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(terminal_session_id) DO UPDATE SET
           scope = excluded.scope,
           section_id = excluded.section_id,
           mode = excluded.mode`
      )
      .run(
        terminalSessionId,
        projectId,
        metadata.scope,
        sectionId,
        metadata.mode,
        existing?.createdAt ?? timestamp
      )
    if (!existing) {
      this.addActivity(
        projectId,
        terminalSessionId,
        'latex-chat-discovered',
        `Restored ${session.name} as a ${metadata.scope} chat in ${metadata.mode} mode`
      )
    }
    return true
  }

  getSessionTmuxMetadataVersion(id: string): number {
    const row = this.db
      .prepare(
        'SELECT tmux_metadata_version AS version FROM terminal_sessions WHERE id = ?'
      )
      .get(id) as { version: number } | undefined
    return row?.version ?? 0
  }

  markSessionTmuxMetadataManaged(id: string): boolean {
    if (this.getSessionTmuxMetadataVersion(id) === 1) return false
    const result = this.db
      .prepare(
        'UPDATE terminal_sessions SET tmux_metadata_version = 1, updated_at = ? WHERE id = ?'
      )
      .run(now(), id)
    return result.changes > 0
  }

  markMissingTmuxSession(id: string): boolean {
    const session = this.getSession(id)
    if (
      !session ||
      session.backend !== 'tmux' ||
      session.state === 'completed' ||
      session.state === 'error'
    ) {
      return false
    }
    return this.setSessionState(
      id,
      'completed',
      `${session.name} is no longer running in tmux.`
    )
  }

  getSession(id: string): TerminalSession | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, name, profile, provider_session_id, provider_session_name,
                custom_command, backend, tmux_name, state,
                dangerous_mode, archived, pinned, output, created_at, updated_at
         FROM terminal_sessions WHERE id = ?`
      )
      .get(id) as SessionRow | undefined
    return row ? mapSession(row, this.getLatexChat(id)) : null
  }

  appendOutput(id: string, data: string): void {
    this.db
      .prepare(
        `UPDATE terminal_sessions
         SET output = substr(output || ?, -?), updated_at = ?
         WHERE id = ?`
      )
      .run(data, OUTPUT_LIMIT, now(), id)
  }

  setSessionState(id: string, state: AgentState, message?: string): boolean {
    const session = this.getSession(id)
    if (!session || session.state === state) return false
    const timestamp = now()
    this.db
      .prepare('UPDATE terminal_sessions SET state = ?, updated_at = ? WHERE id = ?')
      .run(state, timestamp, id)
    if (message) this.addActivity(session.projectId, id, 'state-changed', message)
    this.updateProjectState(session.projectId)
    return true
  }

  setSessionProviderId(id: string, providerSessionId: string): boolean {
    const session = this.requireSession(id)
    const cleaned = providerSessionId.trim()
    if (!cleaned || cleaned.length > 200) {
      throw new Error('The provider session ID is invalid.')
    }
    if (session.providerSessionId === cleaned) return false
    if (session.providerSessionId) {
      throw new Error('This terminal is already linked to a provider session.')
    }
    const duplicate = this.db
      .prepare(
        `SELECT ts.id
         FROM terminal_sessions ts
         JOIN projects owner ON owner.id = ts.project_id
         JOIN projects target ON target.id = ?
         WHERE owner.connection_id = target.connection_id
           AND ts.provider_session_id = ?
           AND ts.id <> ?`
      )
      .get(session.projectId, cleaned, id) as { id: string } | undefined
    if (duplicate) {
      throw new Error('That provider session is already linked to another terminal.')
    }
    this.db
      .prepare(
        'UPDATE terminal_sessions SET provider_session_id = ?, updated_at = ? WHERE id = ?'
      )
      .run(cleaned, now(), id)
    this.addActivity(
      session.projectId,
      id,
      'provider-session-linked',
      `Linked ${session.name} to ${session.profile === 'claude' ? 'Claude' : 'Codex'} session ${cleaned}`
    )
    return true
  }

  listClaimedProviderSessionIds(connectionId: string): Set<string> {
    const rows = this.db
      .prepare(
        `SELECT ts.provider_session_id AS id
         FROM terminal_sessions ts
         JOIN projects p ON p.id = ts.project_id
         WHERE p.connection_id = ? AND ts.provider_session_id IS NOT NULL`
      )
      .all(connectionId) as Array<{ id: string }>
    return new Set(rows.map((row) => row.id))
  }

  renameSession(id: string, name: string, tmuxName?: string | null): void {
    const session = this.requireSession(id)
    const timestamp = now()
    if (this.tableColumns('terminal_sessions').has('label')) {
      this.db
        .prepare(
          `UPDATE terminal_sessions
           SET name = ?, label = ?, tmux_name = COALESCE(?, tmux_name),
               backend_name = COALESCE(?, backend_name), updated_at = ?
           WHERE id = ?`
        )
        .run(name, name, tmuxName ?? null, tmuxName ?? null, timestamp, id)
    } else {
      this.db
        .prepare(
          `UPDATE terminal_sessions
           SET name = ?, tmux_name = COALESCE(?, tmux_name), updated_at = ?
           WHERE id = ?`
        )
        .run(name, tmuxName ?? null, timestamp, id)
    }
    this.addActivity(session.projectId, id, 'terminal-renamed', `Renamed terminal to ${name}`)
  }

  setSessionPinned(id: string, pinned: boolean): void {
    const session = this.requireSession(id)
    if (session.pinned === pinned) return
    this.db
      .prepare('UPDATE terminal_sessions SET pinned = ?, updated_at = ? WHERE id = ?')
      .run(pinned ? 1 : 0, now(), id)
    this.addActivity(
      session.projectId,
      id,
      pinned ? 'terminal-pinned' : 'terminal-unpinned',
      `${pinned ? 'Pinned' : 'Unpinned'} ${session.name}`
    )
  }

  archiveSession(id: string, archived: boolean): void {
    const session = this.requireSession(id)
    if (!['completed', 'error'].includes(session.state)) {
      throw new Error('Only stopped terminals can be archived or restored.')
    }
    this.db
      .prepare('UPDATE terminal_sessions SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, now(), id)
    this.addActivity(
      session.projectId,
      id,
      archived ? 'terminal-archived' : 'terminal-restored',
      `${archived ? 'Archived' : 'Restored'} ${session.name}`
    )
    this.updateProjectState(session.projectId)
  }

  deleteSession(id: string): void {
    const session = this.requireSession(id)
    if (!['completed', 'error'].includes(session.state)) {
      throw new Error('Stop the terminal before deleting it.')
    }
    this.inTransaction(() => {
      this.db.prepare('DELETE FROM agent_events WHERE terminal_session_id = ?').run(id)
      this.db.prepare('DELETE FROM terminal_sessions WHERE id = ?').run(id)
    })
    this.addActivity(session.projectId, null, 'terminal-deleted', `Permanently deleted ${session.name}`)
    this.updateProjectState(session.projectId)
  }

  listPortForwards(connectionId: string): StoredPortForward[] {
    const rows = this.db
      .prepare(
        `SELECT id, connection_id, name, bind_address, local_port, remote_host, remote_port,
                created_at
         FROM port_forwards WHERE connection_id = ? ORDER BY created_at`
      )
      .all(connectionId) as PortForwardRow[]
    return rows.map(mapPortForward)
  }

  getPortForward(id: string): StoredPortForward | null {
    const row = this.db
      .prepare(
        `SELECT id, connection_id, name, bind_address, local_port, remote_host, remote_port,
                created_at
         FROM port_forwards WHERE id = ?`
      )
      .get(id) as PortForwardRow | undefined
    return row ? mapPortForward(row) : null
  }

  createPortForward(input: {
    connectionId: string
    name: string
    localPort: number
    remoteHost: string
    remotePort: number
  }): StoredPortForward {
    const connection = this.getConnection(input.connectionId)
    if (!connection || connection.kind !== 'ssh') {
      throw new Error('Port forwarding requires an SSH connection.')
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO port_forwards
         (id, connection_id, name, bind_address, local_port, remote_host, remote_port, created_at)
         VALUES (?, ?, ?, '127.0.0.1', ?, ?, ?, ?)`
      )
      .run(
        id,
        input.connectionId,
        input.name,
        input.localPort,
        input.remoteHost,
        input.remotePort,
        now()
      )
    return this.getPortForward(id)!
  }

  deletePortForward(id: string): void {
    this.db.prepare('DELETE FROM port_forwards WHERE id = ?').run(id)
  }

  private requireSession(id: string): TerminalSession {
    const session = this.getSession(id)
    if (!session) throw new Error('Terminal session not found.')
    return session
  }

  private addActivity(
    projectId: string,
    sessionId: string | null,
    kind: string,
    message: string
  ): void {
    const timestamp = now()
    if (this.tableColumns('activities').has('content')) {
      this.db
        .prepare(
          `INSERT INTO activities
           (id, project_id, session_id, kind, message, content, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), projectId, sessionId, kind, message, message, timestamp)
    } else {
      this.db
        .prepare(
          `INSERT INTO activities (id, project_id, session_id, kind, message, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(randomUUID(), projectId, sessionId, kind, message, timestamp)
    }
    this.db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(timestamp, projectId)
  }

  private updateProjectState(projectId: string): void {
    const states = this.db
      .prepare('SELECT state FROM terminal_sessions WHERE project_id = ? AND archived = 0')
      .all(projectId) as Array<{ state: AgentState }>
    const aggregate =
      STATE_PRIORITY.find((candidate) => states.some(({ state }) => state === candidate)) ?? 'idle'
    this.db
      .prepare('UPDATE projects SET state = ?, updated_at = ? WHERE id = ?')
      .run(aggregate, now(), projectId)
  }

  private inTransaction(action: () => void): void {
    this.db.exec('BEGIN')
    try {
      action()
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}
