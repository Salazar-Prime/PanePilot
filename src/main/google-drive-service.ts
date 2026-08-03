import { accessSync, constants } from 'node:fs'
import { access, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { execFile } from 'node:child_process'
import { shell } from 'electron'
import type {
  GoogleDriveStatus,
  GoogleDriveUploadResult
} from '../shared/types'
import { resolveLocalFilePath } from './file-service'
import {
  driveUploadPath,
  googleDriveFolderUrl,
  googleDriveItemUrl,
  isGoogleDriveRemoteConfig,
  normalizeDriveFolderPath,
  normalizeRcloneRemoteName,
  parseRcloneStat,
  rcloneRemotePath
} from './google-drive-helpers'
import { downloadRemoteFile } from './remote-file-service'
import { Store } from './store'

const RCLONE_COMMAND_TIMEOUT_MS = 30_000
const RCLONE_UPLOAD_TIMEOUT_MS = 30 * 60_000
const RCLONE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

export type RcloneRunner = (
  executable: string,
  args: string[],
  timeoutMs: number
) => Promise<string>

type OpenExternal = (url: string) => Promise<void>

function executableCandidates(): string[] {
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, process.platform === 'win32' ? 'rclone.exe' : 'rclone'))
  return [
    ...fromPath,
    '/opt/homebrew/bin/rclone',
    '/usr/local/bin/rclone',
    '/usr/bin/rclone'
  ]
}

export function resolveRcloneExecutable(): string | null {
  const seen = new Set<string>()
  for (const candidate of executableCandidates()) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through common GUI-app PATH locations.
    }
  }
  return null
}

const runRclone: RcloneRunner = (executable, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: 'utf8',
        maxBuffer: RCLONE_MAX_OUTPUT_BYTES,
        timeout: timeoutMs,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout)
          return
        }
        const detail = stderr.trim() || stdout.trim()
        reject(
          new Error(
            detail
              ? `rclone: ${detail.slice(0, 1000)}`
              : `rclone failed while running ${args[0] ?? 'a command'}.`
          )
        )
      }
    )
  })

export class GoogleDriveService {
  constructor(
    private readonly store: Store,
    private readonly runner: RcloneRunner = runRclone,
    private readonly findExecutable: () => string | null = resolveRcloneExecutable,
    private readonly openExternal: OpenExternal = async (url) => {
      await shell.openExternal(url)
    }
  ) {}

  status(projectId: string): GoogleDriveStatus {
    if (!this.store.getProject(projectId)) throw new Error('Project not found.')
    const executable = this.findExecutable()
    const connection = this.store.getGoogleDriveConnection(projectId)
    if (!connection) {
      return {
        available: executable != null,
        connected: false,
        remoteName: null,
        folderPath: null,
        destination: null,
        folderId: null,
        folderUrl: null,
        connectedAt: null
      }
    }
    return {
      available: executable != null,
      connected: true,
      remoteName: connection.remoteName,
      folderPath: connection.folderPath,
      destination: rcloneRemotePath(connection.remoteName, connection.folderPath),
      folderId: connection.folderId,
      folderUrl: googleDriveFolderUrl(connection.folderId),
      connectedAt: connection.connectedAt
    }
  }

  async listRemotes(): Promise<string[]> {
    const executable = this.requireExecutable()
    const stdout = await this.runner(executable, ['listremotes'], RCLONE_COMMAND_TIMEOUT_MS)
    const names = stdout
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/:$/, ''))
      .filter(Boolean)
      .map(normalizeRcloneRemoteName)
    const driveRemotes: string[] = []
    for (const name of new Set(names)) {
      const redacted = await this.runner(
        executable,
        ['config', 'redacted', name],
        RCLONE_COMMAND_TIMEOUT_MS
      )
      if (isGoogleDriveRemoteConfig(redacted)) driveRemotes.push(name)
    }
    return driveRemotes.sort((left, right) => left.localeCompare(right))
  }

  async connect(
    projectId: string,
    remoteName: string,
    folderPath: string
  ): Promise<GoogleDriveStatus> {
    if (!this.store.getProject(projectId)) throw new Error('Project not found.')
    const executable = this.requireExecutable()
    const remote = normalizeRcloneRemoteName(remoteName)
    const folder = normalizeDriveFolderPath(folderPath)
    const remotes = await this.listRemotes()
    if (!remotes.includes(remote)) {
      throw new Error(
        `The rclone remote “${remote}” is not configured as Google Drive. Run rclone config first.`
      )
    }
    const item = parseRcloneStat(
      await this.runner(
        executable,
        ['lsjson', rcloneRemotePath(remote, folder), '--stat'],
        RCLONE_COMMAND_TIMEOUT_MS
      )
    )
    if (item.IsDir === false) {
      throw new Error('Choose a Google Drive folder, not a file.')
    }
    const folderId = typeof item.ID === 'string' && item.ID ? item.ID : null
    this.store.saveGoogleDriveConnection({
      projectId,
      remoteName: remote,
      folderPath: folder,
      folderId
    })
    return this.status(projectId)
  }

  disconnect(projectId: string): void {
    if (!this.store.getProject(projectId)) throw new Error('Project not found.')
    this.store.deleteGoogleDriveConnection(projectId)
  }

  async openFolder(projectId: string): Promise<void> {
    const status = this.status(projectId)
    if (!status.folderUrl) {
      throw new Error('Connect an rclone Google Drive folder to this project first.')
    }
    await this.openExternal(status.folderUrl)
  }

  async uploadFile(
    projectId: string,
    relativePath: string
  ): Promise<GoogleDriveUploadResult> {
    const project = this.store.getProject(projectId)
    if (!project) throw new Error('Project not found.')
    const driveConnection = this.store.getGoogleDriveConnection(projectId)
    if (!driveConnection) {
      throw new Error('Connect an rclone Google Drive folder to this project before uploading.')
    }
    const projectConnection = this.store.getConnection(project.connectionId)
    if (!projectConnection) throw new Error('Project connection not found.')
    const executable = this.requireExecutable()
    const destinationPath = driveUploadPath(
      driveConnection.folderPath,
      relativePath
    )
    const destination = rcloneRemotePath(
      driveConnection.remoteName,
      destinationPath
    )

    let temporaryDirectory: string | null = null
    let sourcePath: string
    try {
      if (projectConnection.kind === 'local') {
        sourcePath = resolveLocalFilePath(project.folder, relativePath)
      } else {
        temporaryDirectory = await mkdtemp(join(tmpdir(), 'panepilot-drive-'))
        sourcePath = join(temporaryDirectory, 'project-file')
        await downloadRemoteFile(
          projectConnection.sshAlias!,
          project.folder,
          relativePath,
          sourcePath
        )
      }
      await access(sourcePath, constants.R_OK)
      const sourceStat = await stat(sourcePath)
      if (!sourceStat.isFile()) throw new Error('The requested path is not a file.')

      const existing = this.store.getGoogleDriveFile(projectId, relativePath)
      await this.runner(
        executable,
        ['copyto', sourcePath, destination],
        RCLONE_UPLOAD_TIMEOUT_MS
      )
      const uploaded = parseRcloneStat(
        await this.runner(
          executable,
          ['lsjson', destination, '--stat'],
          RCLONE_COMMAND_TIMEOUT_MS
        )
      )
      if (!uploaded.ID) {
        throw new Error(
          'rclone uploaded the file but did not return a Google Drive ID for its link.'
        )
      }
      const webViewLink = googleDriveItemUrl(uploaded.ID)
      this.store.saveGoogleDriveFile({
        projectId,
        relativePath,
        driveFileId: uploaded.ID,
        webViewLink
      })
      return {
        fileId: uploaded.ID,
        name: uploaded.Name || relativePath.split('/').at(-1) || relativePath,
        webViewLink,
        destination,
        updated: existing != null
      }
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true })
      }
    }
  }

  private requireExecutable(): string {
    const executable = this.findExecutable()
    if (!executable) {
      throw new Error(
        'rclone is not installed. Install it with “brew install rclone”, then run “rclone config”.'
      )
    }
    return executable
  }
}
