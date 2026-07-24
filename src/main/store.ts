import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  Activity,
  AgentState,
  Connection,
  LaunchProfile,
  Project,
  TerminalBackend,
  TerminalSession
} from '../shared/types'

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
  type: 'terminal'
  name: string
  connection_id: string
  folder: string
  repository_url: string | null
  state: AgentState
  archived: number
  created_at: string
  updated_at: string
}

type SessionRow = {
  id: string
  project_id: string
  name: string
  profile: LaunchProfile
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

function mapSession(row: SessionRow): TerminalSession {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    profile: row.profile,
    customCommand: row.custom_command,
    backend: row.backend,
    tmuxName: row.tmux_name,
    state: row.state,
    dangerousMode: Boolean(row.dangerous_mode),
    archived: Boolean(row.archived),
    pinned: Boolean(row.pinned),
    output: row.output,
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
        custom_command TEXT,
        backend TEXT NOT NULL,
        tmux_name TEXT,
        state TEXT NOT NULL DEFAULT 'idle',
        dangerous_mode INTEGER NOT NULL DEFAULT 0,
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
    `)

    this.ensureColumn('connections', 'ssh_alias', 'TEXT')
    this.ensureColumn('projects', 'created_at', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('projects', 'archived', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('terminal_sessions', 'name', `TEXT NOT NULL DEFAULT ''`)
    this.ensureColumn('terminal_sessions', 'custom_command', 'TEXT')
    this.ensureColumn('terminal_sessions', 'tmux_name', 'TEXT')
    this.ensureColumn('terminal_sessions', 'dangerous_mode', 'INTEGER NOT NULL DEFAULT 0')
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
      CREATE INDEX IF NOT EXISTS activities_project_idx
        ON activities(project_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS port_forwards_connection_idx
        ON port_forwards(connection_id, created_at);

      UPDATE projects SET parent_id = NULL WHERE parent_id IS NOT NULL;
      PRAGMA user_version = 2;
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
    name: string
    connectionId: string
    folder: string
    repositoryUrl: string | null
  }): Project {
    const id = randomUUID()
    const timestamp = now()
    this.db
      .prepare(
        `INSERT INTO projects
         (id, type, name, connection_id, folder, repository_url, state, created_at, updated_at)
         VALUES (?, 'terminal', ?, ?, ?, ?, 'idle', ?, ?)`
      )
      .run(
        id,
        input.name,
        input.connectionId,
        input.folder,
        input.repositoryUrl,
        timestamp,
        timestamp
      )
    this.addActivity(id, null, 'project-created', `Created project in ${input.folder}`)
    return this.getProject(id)!
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
      throw new Error('Stop every running terminal before archiving this project.')
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

  private hydrateProject(row: ProjectRow): Project {
    const sessions = (
      this.db
        .prepare(
          `SELECT id, project_id, name, profile, custom_command, backend, tmux_name, state,
                  dangerous_mode, archived, pinned, output, created_at, updated_at
           FROM terminal_sessions WHERE project_id = ? ORDER BY created_at`
        )
        .all(row.id) as SessionRow[]
    ).map(mapSession)
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
           (id, project_id, name, label, profile, custom_command, command, backend, tmux_name,
            backend_name, state, dangerous_mode, dangerous, archived, pinned, output,
            created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?, 0, 0, '', ?, ?)`
        )
        .run(
          id,
          input.projectId,
          input.name,
          input.name,
          input.profile,
          input.customCommand,
          input.customCommand,
          input.backend,
          input.tmuxName,
          input.tmuxName,
          input.dangerousMode ? 1 : 0,
          input.dangerousMode ? 1 : 0,
          timestamp,
          timestamp
        )
    } else {
      this.db
        .prepare(
          `INSERT INTO terminal_sessions
           (id, project_id, name, profile, custom_command, backend, tmux_name, state,
            dangerous_mode, archived, pinned, output, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'idle', ?, 0, 0, '', ?, ?)`
        )
        .run(
          id,
          input.projectId,
          input.name,
          input.profile,
          input.customCommand,
          input.backend,
          input.tmuxName,
          input.dangerousMode ? 1 : 0,
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

  getSession(id: string): TerminalSession | null {
    const row = this.db
      .prepare(
        `SELECT id, project_id, name, profile, custom_command, backend, tmux_name, state,
                dangerous_mode, archived, pinned, output, created_at, updated_at
         FROM terminal_sessions WHERE id = ?`
      )
      .get(id) as SessionRow | undefined
    return row ? mapSession(row) : null
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
