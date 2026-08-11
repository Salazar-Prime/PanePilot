import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GitService,
  gitRemoteCommand,
  parseGitGraph,
  parseGitPorcelainV2
} from '../src/main/git'
import { Store } from '../src/main/store'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function git(folder: string, ...args: string[]): string {
  return execFileSync('git', ['-C', folder, ...args], { encoding: 'utf8' })
}

describe('Git porcelain parsing', () => {
  it('separates staged, working, renamed, conflicted, and untracked state', () => {
    const raw = [
      '# branch.oid abcdef1234567890',
      '# branch.head feature/git-pane',
      '# branch.upstream origin/feature/git-pane',
      '# branch.ab +2 -1',
      '# stash 3',
      '1 M. N... 100644 100644 100644 aaaaaaa bbbbbbb staged.ts',
      '1 .M N... 100644 100644 100644 aaaaaaa bbbbbbb working file.ts',
      '2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 renamed.ts',
      'old name.ts',
      'u UU N... 100644 100644 100644 100644 aaaaaaa bbbbbbb ccccccc conflict.ts',
      '1 .. S.MU 160000 160000 160000 ddddddd ddddddd nested-module',
      '? new file.md'
    ].join('\0')

    expect(parseGitPorcelainV2(raw)).toEqual({
      branch: 'feature/git-pane',
      detached: false,
      head: 'abcdef1234567890',
      upstream: 'origin/feature/git-pane',
      ahead: 2,
      behind: 1,
      stashCount: 3,
      changes: [
        expect.objectContaining({ path: 'staged.ts', staged: 'modified' }),
        expect.objectContaining({
          path: 'working file.ts',
          workingTree: 'modified'
        }),
        expect.objectContaining({
          path: 'renamed.ts',
          previousPath: 'old name.ts',
          staged: 'renamed'
        }),
        expect.objectContaining({ path: 'conflict.ts', conflicted: true }),
        expect.objectContaining({
          path: 'nested-module',
          workingTree: 'modified'
        }),
        expect.objectContaining({ path: 'new file.md', untracked: true })
      ]
    })
  })

  it('parses graph rails and decorations from Git log output', () => {
    const raw =
      '* \u001eabcdef1234567890\u001fabcdef1\u001fparent1 parent2\u001fHEAD -> main, tag: v1.0.0\u001fAda\u001f2026-08-11T10:00:00-04:00\u001fShip Git pane\n'

    expect(parseGitGraph(raw)).toEqual([
      {
        hash: 'abcdef1234567890',
        shortHash: 'abcdef1',
        parents: ['parent1', 'parent2'],
        decorations: ['HEAD -> main', 'tag: v1.0.0'],
        author: 'Ada',
        authoredAt: '2026-08-11T10:00:00-04:00',
        subject: 'Ship Git pane',
        graph: '*'
      }
    ])
  })

  it('quotes every remote Git argument', () => {
    expect(gitRemoteCommand("/srv/worker's project", ['status', '--short'])).toBe(
      "'git' '--no-optional-locks' '-C' '/srv/worker'\\''s project' 'status' '--short'"
    )
  })
})

describe('project Git service', () => {
  it('reads current changes and paginates commits from a local project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-git-test-'))
    temporaryDirectories.push(root)
    const projectFolder = join(root, 'project')
    const appData = join(root, 'app-data')
    mkdirSync(projectFolder)
    mkdirSync(appData)
    git(projectFolder, 'init', '-b', 'main')
    git(projectFolder, 'config', 'user.name', 'PanePilot Test')
    git(projectFolder, 'config', 'user.email', 'panepilot@example.test')
    writeFileSync(join(projectFolder, 'tracked.txt'), 'first\n')
    git(projectFolder, 'add', 'tracked.txt')
    git(projectFolder, 'commit', '-m', 'Initial commit')
    writeFileSync(join(projectFolder, 'tracked.txt'), 'second\n')
    writeFileSync(join(projectFolder, 'staged.txt'), 'ready\n')
    writeFileSync(join(projectFolder, 'untracked.txt'), 'new\n')
    git(projectFolder, 'add', 'staged.txt')

    const store = new Store(appData)
    store.syncConnections([])
    const project = store.createProject({
      type: 'terminal',
      name: 'Git test',
      connectionId: 'local',
      folder: projectFolder,
      repositoryUrl: null
    })

    try {
      const service = new GitService(store)
      const status = await service.status(project.id)
      expect(status).toMatchObject({
        isRepository: true,
        root: realpathSync(projectFolder),
        branch: 'main',
        clean: false
      })
      expect(status.changes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: 'tracked.txt', workingTree: 'modified' }),
          expect.objectContaining({ path: 'staged.txt', staged: 'added' }),
          expect.objectContaining({ path: 'untracked.txt', untracked: true })
        ])
      )

      const page = await service.commits(project.id, 0, 1)
      expect(page).toMatchObject({ total: 1, hasMore: false })
      expect(page.commits[0]).toMatchObject({
        subject: 'Initial commit',
        author: 'PanePilot Test'
      })
    } finally {
      store.close()
    }
  })

  it('returns a useful empty state for a folder without Git metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'panepilot-no-git-test-'))
    temporaryDirectories.push(root)
    const projectFolder = join(root, 'project')
    const appData = join(root, 'app-data')
    mkdirSync(projectFolder)
    mkdirSync(appData)
    const store = new Store(appData)
    store.syncConnections([])
    const project = store.createProject({
      type: 'terminal',
      name: 'No Git',
      connectionId: 'local',
      folder: projectFolder,
      repositoryUrl: null
    })

    try {
      const service = new GitService(store)
      await expect(service.status(project.id)).resolves.toMatchObject({
        isRepository: false,
        message: 'This project folder is not a Git repository.'
      })
      await expect(service.commits(project.id)).resolves.toEqual({
        commits: [],
        offset: 0,
        total: 0,
        hasMore: false
      })
    } finally {
      store.close()
    }
  })
})
