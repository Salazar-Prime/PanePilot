import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  driveUploadPath,
  googleDriveFolderUrl,
  googleDriveItemUrl,
  isGoogleDriveRemoteConfig,
  normalizeDriveFolderPath,
  normalizeRcloneRemoteName,
  parseRcloneStat,
  rcloneRemotePath
} from '../src/main/google-drive-helpers'
import {
  GoogleDriveService,
  type RcloneRunner
} from '../src/main/google-drive-service'
import { Store } from '../src/main/store'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function projectStore(): { store: Store; projectId: string; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'panepilot-drive-test-'))
  temporaryDirectories.push(directory)
  const store = new Store(directory)
  store.syncConnections([])
  const project = store.createProject({
    type: 'terminal',
    name: 'Drive test',
    connectionId: 'local',
    folder: directory,
    repositoryUrl: null
  })
  return { store, projectId: project.id, directory }
}

describe('rclone Google Drive helpers', () => {
  it('normalizes remotes, folders, and project-relative destinations', () => {
    expect(normalizeRcloneRemoteName(' personal-drive: ')).toBe('personal-drive')
    expect(normalizeDriveFolderPath('/PanePilot/Research/')).toBe(
      'PanePilot/Research'
    )
    expect(rcloneRemotePath('personal-drive', 'PanePilot/Research')).toBe(
      'personal-drive:PanePilot/Research'
    )
    expect(driveUploadPath('PanePilot/Research', 'drafts/paper.tex')).toBe(
      'PanePilot/Research/drafts/paper.tex'
    )
    expect(() => normalizeRcloneRemoteName('../bad:remote')).toThrow(/invalid/)
    expect(() => normalizeDriveFolderPath('safe/../escape')).toThrow(/cannot contain/)
    expect(isGoogleDriveRemoteConfig('[personal-drive]\ntype = drive\ntoken = XXX')).toBe(
      true
    )
    expect(isGoogleDriveRemoteConfig('[archive]\ntype = s3')).toBe(false)
  })

  it('builds private Drive item and folder URLs from rclone IDs', () => {
    expect(parseRcloneStat('{"ID":"file_ABC-123","Name":"paper.tex"}')).toEqual({
      ID: 'file_ABC-123',
      Name: 'paper.tex'
    })
    expect(googleDriveItemUrl('file_ABC-123')).toBe(
      'https://drive.google.com/open?id=file_ABC-123'
    )
    expect(googleDriveFolderUrl('folder_ABC-123')).toBe(
      'https://drive.google.com/drive/folders/folder_ABC-123'
    )
    expect(googleDriveFolderUrl(null)).toBe(
      'https://drive.google.com/drive/my-drive'
    )
    expect(() => googleDriveItemUrl('../bad')).toThrow(/invalid/)
  })
})

describe('project-scoped rclone persistence and uploads', () => {
  it('replaces the unreleased token schema without retaining OAuth secrets', () => {
    const directory = mkdtempSync(join(tmpdir(), 'panepilot-drive-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'project-console.sqlite')
    const legacy = new DatabaseSync(databasePath)
    legacy.exec(`
      CREATE TABLE google_drive_connections (
        project_id TEXT PRIMARY KEY,
        client_id TEXT NOT NULL,
        encrypted_client_secret BLOB NOT NULL,
        encrypted_refresh_token BLOB NOT NULL,
        account_email TEXT NOT NULL,
        account_name TEXT NOT NULL,
        folder_id TEXT NOT NULL,
        connected_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE google_drive_files (
        project_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        drive_file_id TEXT NOT NULL,
        web_view_link TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, relative_path)
      );
    `)
    legacy.close()

    const store = new Store(directory)
    store.close()
    const migrated = new DatabaseSync(databasePath)
    try {
      const columns = migrated
        .prepare('PRAGMA table_info(google_drive_connections)')
        .all() as Array<{ name: string }>
      expect(columns.map(({ name }) => name)).toEqual([
        'project_id',
        'remote_name',
        'folder_path',
        'folder_id',
        'connected_at',
        'updated_at'
      ])
    } finally {
      migrated.close()
    }
  })

  it('stores one remote/folder per project and logs the returned file link', async () => {
    const { store, projectId, directory } = projectStore()
    const drafts = join(directory, 'drafts')
    mkdirSync(drafts)
    writeFileSync(join(drafts, 'paper.tex'), '\\section{Draft}\n')
    const calls: string[][] = []
    const runner: RcloneRunner = async (_executable, args) => {
      calls.push(args)
      if (args[0] === 'listremotes') return 'personal-drive:\nwork-drive:\n'
      if (args[0] === 'config') {
        return args[2] === 'personal-drive'
          ? '[personal-drive]\ntype = drive\ntoken = XXX\n'
          : '[work-drive]\ntype = s3\n'
      }
      if (args[0] === 'copyto') return ''
      if (args[1] === 'personal-drive:PanePilot/Research') {
        return '{"ID":"folder-id","Name":"Research","IsDir":true}'
      }
      return '{"ID":"file-id","Name":"paper.tex","IsDir":false}'
    }
    const service = new GoogleDriveService(
      store,
      runner,
      () => '/mock/rclone',
      async () => undefined
    )

    try {
      const connected = await service.connect(
        projectId,
        'personal-drive',
        'PanePilot/Research'
      )
      expect(connected).toMatchObject({
        available: true,
        connected: true,
        remoteName: 'personal-drive',
        folderPath: 'PanePilot/Research',
        destination: 'personal-drive:PanePilot/Research'
      })
      expect(store.getGoogleDriveConnection(projectId)).toMatchObject({
        remoteName: 'personal-drive',
        folderPath: 'PanePilot/Research',
        folderId: 'folder-id'
      })

      const uploaded = await service.uploadFile(projectId, 'drafts/paper.tex')
      expect(uploaded).toEqual({
        fileId: 'file-id',
        name: 'paper.tex',
        webViewLink: 'https://drive.google.com/open?id=file-id',
        destination: 'personal-drive:PanePilot/Research/drafts/paper.tex',
        updated: false
      })
      expect(calls).toContainEqual([
        'copyto',
        join(realpathSync(directory), 'drafts/paper.tex'),
        'personal-drive:PanePilot/Research/drafts/paper.tex'
      ])
      expect(
        store
          .getProject(projectId)
          ?.activities.find((activity) => activity.kind === 'google-drive-file-uploaded')
          ?.message
      ).toBe(
        'Uploaded drafts/paper.tex in Google Drive · https://drive.google.com/open?id=file-id'
      )

      expect((await service.uploadFile(projectId, 'drafts/paper.tex')).updated).toBe(
        true
      )
    } finally {
      store.close()
    }
  })
})
