import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { projectTypeServices } from '../src/main/project-type-services'
import { Store } from '../src/main/store'
import {
  fuzzyFilterFolderEntries,
  newProjectFolderDestination,
  remoteFolderFilterQuery,
  remoteFolderInputValue,
  suggestedProjectName
} from '../src/renderer/src/lib/projectCreation'

const temporaryDirectories: string[] = []

function createStore(): { root: string; store: Store } {
  const root = mkdtempSync(join(tmpdir(), 'panepilot-project-creation-'))
  temporaryDirectories.push(root)
  const appData = join(root, 'app-data')
  mkdirSync(appData)
  const store = new Store(appData)
  store.syncConnections([])
  return { root, store }
}

afterEach(() => {
  while (temporaryDirectories.length) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true })
  }
})

describe('new project folder creation', () => {
  it('uses the new folder name as the suggested project name and path', () => {
    expect(suggestedProjectName('new', '/Users/me/Work', 'sal3000')).toBe(
      'sal3000'
    )
    expect(suggestedProjectName('existing', '/Users/me/Work/sal3000/', '')).toBe(
      'sal3000'
    )
    expect(newProjectFolderDestination('/Users/me/Work/', 'sal3000')).toBe(
      '/Users/me/Work/sal3000'
    )
    expect(newProjectFolderDestination('/', 'sal3000')).toBe('/sal3000')
  })

  it('fuzzy-filters folders typed after the current remote path', () => {
    const entries = [
      { name: 'archive', path: '/home/me/archive' },
      { name: 'deepstream-tools', path: '/home/me/deepstream-tools' },
      {
        name: 'detectionThruDeepstream',
        path: '/home/me/detectionThruDeepstream'
      }
    ]

    expect(
      remoteFolderInputValue('/home/me', '/home/me', '/home/medtds')
    ).toBe('/home/me/dtds')
    expect(remoteFolderFilterQuery('/home/me', '/home/me/dtds')).toBe('dtds')
    expect(
      fuzzyFilterFolderEntries(entries, 'dtds').map((entry) => entry.name)
    ).toEqual(['detectionThruDeepstream'])
    expect(
      fuzzyFilterFolderEntries(entries, 'deep').map((entry) => entry.name)
    ).toEqual(['deepstream-tools', 'detectionThruDeepstream'])
  })

  it('exposes existing and new folder choices in the New Project dialog', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'src/renderer/src/components/NewProjectDialog.tsx'
      ),
      'utf8'
    )

    expect(component).toContain('Use existing folder')
    expect(component).toContain('Create new folder')
    expect(component).toContain("folderMode === 'new' ? 'parent' : 'project'")
    expect(component).toContain('newFolderName.trim()')
  })

  it('creates a collision-safe local folder before adding the project', async () => {
    const { root, store } = createStore()
    const parent = join(root, 'projects')
    mkdirSync(parent)
    const connection = store.getConnection('local')!

    try {
      const project = await projectTypeServices.get('terminal')!.create(
        store,
        {
          type: 'terminal',
          name: 'Fresh project',
          connectionId: connection.id,
          folder: parent,
          newFolderName: 'fresh-project'
        },
        connection
      )

      expect(project.folder).toBe(realpathSync(join(parent, 'fresh-project')))
      expect(existsSync(project.folder)).toBe(true)
    } finally {
      store.close()
    }
  })

  it('creates a new folder through the selected SSH connection', async () => {
    const { root, store } = createStore()
    const parent = join(root, 'remote-projects')
    const bin = join(root, 'bin')
    const ssh = join(bin, 'ssh')
    const originalPath = process.env.PATH
    mkdirSync(parent)
    mkdirSync(bin)
    writeFileSync(
      ssh,
      `#!/bin/sh
for panepilot_argument in "$@"; do
  panepilot_command="$panepilot_argument"
done
exec /bin/sh -c "$panepilot_command"
`
    )
    chmodSync(ssh, 0o755)
    process.env.PATH = `${bin}:${originalPath ?? ''}`
    store.syncConnections(['test-remote'])
    const connection = store.getConnection('ssh:test-remote')!

    try {
      const project = await projectTypeServices.get('terminal')!.create(
        store,
        {
          type: 'terminal',
          name: 'Remote project',
          connectionId: connection.id,
          folder: parent,
          newFolderName: 'remote-project'
        },
        connection
      )

      expect(project.folder).toBe(realpathSync(join(parent, 'remote-project')))
      expect(existsSync(project.folder)).toBe(true)
    } finally {
      if (originalPath == null) delete process.env.PATH
      else process.env.PATH = originalPath
      store.close()
    }
  })

  it('does not overwrite an existing folder or allow a path as the name', async () => {
    const { root, store } = createStore()
    const parent = join(root, 'projects')
    mkdirSync(parent)
    mkdirSync(join(parent, 'already-here'))
    const connection = store.getConnection('local')!
    const service = projectTypeServices.get('terminal')!

    try {
      await expect(
        service.create(
          store,
          {
            type: 'terminal',
            name: 'Collision',
            connectionId: connection.id,
            folder: parent,
            newFolderName: 'already-here'
          },
          connection
        )
      ).rejects.toThrow('already exists')
      await expect(
        service.create(
          store,
          {
            type: 'terminal',
            name: 'Escape',
            connectionId: connection.id,
            folder: parent,
            newFolderName: '../escape'
          },
          connection
        )
      ).rejects.toThrow('without path separators')
      expect(existsSync(join(root, 'escape'))).toBe(false)
    } finally {
      store.close()
    }
  })

  it('adds a minimal configured main file to a new LaTeX folder', async () => {
    const { root, store } = createStore()
    const parent = join(root, 'papers')
    mkdirSync(parent)
    const connection = store.getConnection('local')!

    try {
      const project = await projectTypeServices.get('latex')!.create(
        store,
        {
          type: 'latex',
          name: 'New paper',
          connectionId: connection.id,
          folder: parent,
          newFolderName: 'new-paper',
          latex: {
            mainFile: 'manuscript/main.tex',
            contextFolder: 'context'
          }
        },
        connection
      )
      const mainFile = join(project.folder, 'manuscript', 'main.tex')

      expect(readFileSync(mainFile, 'utf8')).toContain(
        String.raw`\documentclass{article}`
      )
      expect(project.latex?.mainFile).toBe('manuscript/main.tex')
    } finally {
      store.close()
    }
  })
})
