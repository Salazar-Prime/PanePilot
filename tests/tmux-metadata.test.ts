import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import {
  encodePanePilotTmuxMetadata,
  PANEPILOT_TMUX_OPTION_KEYS,
  parseTmuxSessionList,
  sameRemoteProjectPath,
  TMUX_FIELD_SEPARATOR,
  tmuxMetadataShellCommand,
  tmuxSessionListFormat,
  type PanePilotTmuxMetadata
} from '../src/main/tmux-metadata'

const TERMINAL_ID = '550e8400-e29b-41d4-a716-446655440000'
const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const SECTION_ID = '22222222-2222-4222-8222-222222222222'
const ACTION_ID = '33333333-3333-4333-8333-333333333333'

function metadata(
  overrides: Partial<PanePilotTmuxMetadata> = {}
): PanePilotTmuxMetadata {
  return {
    terminalId: TERMINAL_ID,
    originProjectId: PROJECT_ID,
    projectPath: '/srv/papers/example',
    profile: 'codex',
    providerSessionId: 'provider-session-123',
    providerSessionName: 'Codex 1 · abc123',
    createdAt: '2026-07-24T12:00:00.000Z',
    dangerousMode: false,
    sessionKind: 'terminal',
    action: null,
    latex: null,
    ...overrides
  }
}

function tmuxListLine(
  value: PanePilotTmuxMetadata,
  name = 'Codex 1',
  separator = TMUX_FIELD_SEPARATOR
): string {
  const encoded = encodePanePilotTmuxMetadata(value)
  return [
    '$7',
    name,
    '1',
    'Working · 2/4 tasks',
    'codex',
    '0',
    ...PANEPILOT_TMUX_OPTION_KEYS.map((key) => encoded[key] ?? '')
  ].join(separator)
}

describe('PanePilot tmux metadata', () => {
  it('round-trips stable terminal, project, provider, and LaTeX identities', () => {
    const value = metadata({
      dangerousMode: true,
      latex: {
        scope: 'section',
        mode: 'edit',
        sectionId: SECTION_ID,
        sectionSource: 'sections/results.tex',
        sectionTitle: 'Results & analysis',
        sectionLevel: 2
      }
    })

    expect(parseTmuxSessionList(tmuxListLine(value))).toEqual([
      {
        tmuxId: '$7',
        name: 'Codex 1',
        attachedClients: 1,
        paneTitle: 'Working · 2/4 tasks',
        paneCurrentCommand: 'codex',
        paneDead: false,
        metadata: value
      }
    ])
  })

  it('parses raw field separators emitted by older tmux versions', () => {
    expect(parseTmuxSessionList(tmuxListLine(metadata(), 'Codex 1', '\u001f'))).toEqual([
      expect.objectContaining({
        name: 'Codex 1',
        metadata: metadata()
      })
    ])
  })

  it('lists untagged tmux sessions without treating them as PanePilot sessions', () => {
    const line = [
      '$2',
      'existing shell',
      '0',
      'shell',
      'zsh',
      '0',
      ...PANEPILOT_TMUX_OPTION_KEYS.map(() => '')
    ]
      .join(TMUX_FIELD_SEPARATOR)

    expect(parseTmuxSessionList(line)[0]).toMatchObject({
      tmuxId: '$2',
      name: 'existing shell',
      metadata: null
    })
  })

  it('round-trips an ephemeral Action definition with its live run', () => {
    const value = metadata({
      profile: 'custom',
      providerSessionId: null,
      providerSessionName: null,
      sessionKind: 'action',
      action: {
        id: ACTION_ID,
        name: 'Run tests',
        command: 'npm test'
      }
    })

    expect(parseTmuxSessionList(tmuxListLine(value, 'Action · Run tests'))[0])
      .toMatchObject({
        name: 'Action · Run tests',
        metadata: value
      })
  })

  it('builds shell-safe set and unset commands for session options', () => {
    const command = tmuxMetadataShellCommand(
      metadata({ providerSessionId: null }),
      "Codex user's session",
      true
    )

    expect(command).toContain("'@panepilot_terminal_id' '550e8400-e29b-41d4-a716-446655440000'")
    expect(command).toContain("set-option -q -u -t '=Codex user'\\''s session:'")
    expect(command).toContain("'@panepilot_provider_session_id'")
  })

  it('normalizes remote project paths before matching', () => {
    expect(
      sameRemoteProjectPath('/srv/papers/example/', '/srv/papers/./example')
    ).toBe(true)
    expect(
      sameRemoteProjectPath('/srv/papers/example', '/srv/papers/other')
    ).toBe(false)
  })

  it.skipIf(spawnSync('tmux', ['-V']).status !== 0)(
    'stores and lists metadata on a real tmux session',
    async () => {
      const name = `panepilot-metadata-test-${randomUUID()}`
      const launch =
        `(${tmuxMetadataShellCommand(metadata())}) || true; exec sleep 30`
      const created = spawnSync(
        'tmux',
        ['new-session', '-d', '-s', name, launch],
        { encoding: 'utf8' }
      )
      expect(created.status, created.stderr).toBe(0)
      try {
        let discovered: PanePilotTmuxMetadata | null | undefined
        for (let attempt = 0; attempt < 20 && !discovered; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20))
          const listed = spawnSync(
            'tmux',
            ['list-sessions', '-F', tmuxSessionListFormat()],
            { encoding: 'utf8' }
          )
          expect(listed.status, listed.stderr).toBe(0)
          discovered = parseTmuxSessionList(listed.stdout).find(
            (session) => session.name === name
          )?.metadata
        }
        expect(discovered).toEqual(metadata())

        const updated = metadata({
          providerSessionId: 'provider-session-updated',
          providerSessionName: null
        })
        const synced = spawnSync(
          'sh',
          ['-lc', tmuxMetadataShellCommand(updated, name, true)],
          { encoding: 'utf8' }
        )
        expect(synced.status, synced.stderr).toBe(0)
        const relisted = spawnSync(
          'tmux',
          ['list-sessions', '-F', tmuxSessionListFormat()],
          { encoding: 'utf8' }
        )
        expect(
          parseTmuxSessionList(relisted.stdout).find(
            (session) => session.name === name
          )?.metadata
        ).toEqual(updated)
      } finally {
        spawnSync('tmux', ['kill-session', '-t', `=${name}`])
      }
    }
  )
})

describe('tmux discovery persistence', () => {
  let appDataPath: string | null = null

  afterEach(() => {
    if (appDataPath) rmSync(appDataPath, { recursive: true, force: true })
    appDataPath = null
  })

  it('imports a foreign live session and reactivates the same stable UUID', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-tmux-store-'))
    const store = new Store(appDataPath)
    try {
      store.syncConnections(['remote-work'])
      const project = store.createProject({
        type: 'terminal',
        name: 'Remote service',
        connectionId: 'ssh:remote-work',
        folder: '/srv/papers/example',
        repositoryUrl: null
      })

      const imported = store.upsertDiscoveredTmuxSession(
        project.id,
        'Codex 1',
        metadata()
      )
      expect(imported?.changed).toBe(true)
      expect(imported?.session).toMatchObject({
        id: TERMINAL_ID,
        projectId: project.id,
        name: 'Codex 1',
        backend: 'tmux',
        tmuxName: 'Codex 1',
        providerSessionId: 'provider-session-123',
        state: 'idle'
      })
      expect(store.getSessionTmuxMetadataVersion(TERMINAL_ID)).toBe(1)

      store.setSessionState(TERMINAL_ID, 'completed')
      const rediscovered = store.upsertDiscoveredTmuxSession(
        project.id,
        'Renamed agent',
        metadata()
      )
      expect(rediscovered?.session).toMatchObject({
        id: TERMINAL_ID,
        name: 'Renamed agent',
        tmuxName: 'Renamed agent',
        state: 'idle'
      })
    } finally {
      store.close()
    }
  })

  it('restores portable LaTeX section scope for an imported chat', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-latex-tmux-store-'))
    const store = new Store(appDataPath)
    try {
      store.syncConnections(['remote-work'])
      const project = store.createProject({
        type: 'latex',
        name: 'Remote paper',
        connectionId: 'ssh:remote-work',
        folder: '/srv/papers/example',
        repositoryUrl: null,
        latex: {
          mainFile: 'main.tex',
          overleafUrl: null,
          contextFolder: 'context'
        }
      })
      const value = metadata({
        latex: {
          scope: 'section',
          mode: 'edit',
          sectionId: SECTION_ID,
          sectionSource: 'sections/results.tex',
          sectionTitle: 'Results',
          sectionLevel: 2
        }
      })
      store.upsertDiscoveredTmuxSession(project.id, 'Results editor', value)

      expect(
        store.upsertDiscoveredLatexChat(
          TERMINAL_ID,
          project.id,
          value.latex!
        )
      ).toBe(true)
      expect(store.getSession(TERMINAL_ID)?.latexChat).toMatchObject({
        scope: 'section',
        mode: 'edit',
        sectionId: SECTION_ID
      })
      expect(store.getLatexSection(SECTION_ID)).toMatchObject({
        title: 'Results',
        sourceFile: 'sections/results.tex'
      })
    } finally {
      store.close()
    }
  })

  it('restores a live remote Action without exposing it as an ordinary terminal', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-action-tmux-store-'))
    const store = new Store(appDataPath)
    try {
      store.syncConnections(['remote-work'])
      const project = store.createProject({
        type: 'terminal',
        name: 'Remote service',
        connectionId: 'ssh:remote-work',
        folder: '/srv/papers/example',
        repositoryUrl: null
      })
      const value = metadata({
        profile: 'custom',
        providerSessionId: null,
        providerSessionName: null,
        sessionKind: 'action',
        action: {
          id: ACTION_ID,
          name: 'Run tests',
          command: 'npm test'
        }
      })
      const discovered = store.upsertDiscoveredTmuxSession(
        project.id,
        'Action · Run tests',
        value
      )

      expect(discovered?.session.kind).toBe('action')
      expect(
        store.upsertDiscoveredProjectAction(
          project.id,
          TERMINAL_ID,
          value.action!
        )
      ).toBe(true)
      expect(store.getProject(project.id)?.actions).toEqual([
        expect.objectContaining({
          id: ACTION_ID,
          command: 'npm test',
          lastSessionId: TERMINAL_ID
        })
      ])
    } finally {
      store.close()
    }
  })

  it('adds the tmux metadata version to an existing version-five database', () => {
    appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-tmux-migration-'))
    const initial = new Store(appDataPath)
    initial.close()

    const databasePath = join(appDataPath, 'project-console.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      ALTER TABLE terminal_sessions DROP COLUMN tmux_metadata_version;
      PRAGMA user_version = 5;
    `)
    legacy.close()

    const migrated = new Store(appDataPath)
    try {
      migrated.syncConnections([])
      const project = migrated.createProject({
        type: 'terminal',
        name: 'Local project',
        connectionId: 'local',
        folder: '/tmp/project',
        repositoryUrl: null
      })
      const session = migrated.createSession({
        projectId: project.id,
        name: 'Shell 1',
        profile: 'shell',
        providerSessionName: null,
        customCommand: null,
        backend: 'tmux',
        tmuxName: 'Shell 1',
        dangerousMode: false
      })

      expect(migrated.getSessionTmuxMetadataVersion(session.id)).toBe(1)
    } finally {
      migrated.close()
    }
  })
})
