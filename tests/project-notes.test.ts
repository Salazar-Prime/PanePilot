import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectMetadataService } from '../src/main/project-metadata-service'
import { Store } from '../src/main/store'

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function createProject() {
  const appDataPath = mkdtempSync(join(tmpdir(), 'panepilot-notes-'))
  temporaryRoots.push(appDataPath)
  const store = new Store(appDataPath)
  store.syncConnections([])
  const projectFolder = join(appDataPath, 'project')
  mkdirSync(projectFolder)
  const project = store.createProject({
    type: 'terminal',
    name: 'Project',
    connectionId: 'local',
    folder: projectFolder,
    repositoryUrl: null
  })
  return {
    store,
    project,
    projectFolder,
    metadata: new ProjectMetadataService(store)
  }
}

describe('project notes', async () => {
  it('manages multiple Markdown notes inside .panepilot/notes', async () => {
    const { store, project, projectFolder, metadata } = createProject()
    try {
      expect(await metadata.listNotes(project.id)).toEqual([])

      const decisions = await metadata.createNote(project.id, 'Decisions')
      const tasks = await metadata.createNote(project.id, 'Tasks.md')
      expect((await metadata.listNotes(project.id)).map((note) => note.name)).toEqual([
        'Decisions',
        'Tasks'
      ])

      const content = '# Decisions\n\n- Keep metadata in the project\n'
      expect(
        (await metadata.writeNote(project.id, decisions.path, content)).content
      ).toBe(content)
      expect(
        readFileSync(
          join(projectFolder, '.panepilot', 'notes', 'Decisions.md'),
          'utf8'
        )
      ).toBe(content)

      const renamed = await metadata.renameNote(project.id, tasks.path, 'Follow ups')
      expect(renamed.path).toBe('Follow ups.md')
      await metadata.deleteNote(project.id, decisions.path)
      expect((await metadata.listNotes(project.id)).map((note) => note.path)).toEqual([
        'Follow ups.md'
      ])
    } finally {
      store.close()
    }
  })

  it('migrates the legacy .notes-panepilot file into the notes folder', async () => {
    const { store, project, projectFolder, metadata } = createProject()
    const content = '# Legacy notes\n'
    writeFileSync(join(projectFolder, '.notes-panepilot'), content)
    try {
      expect(await metadata.listNotes(project.id)).toEqual([
        expect.objectContaining({
          path: 'Project notes.md',
          name: 'Project notes'
        })
      ])
      expect((await metadata.readNote(project.id, 'Project notes.md')).content).toBe(
        content
      )
      expect(existsSync(join(projectFolder, '.notes-panepilot'))).toBe(false)
    } finally {
      store.close()
    }
  })

  it('refuses to follow a .panepilot symlink outside the project', async () => {
    const { store, project, projectFolder, metadata } = createProject()
    const outside = mkdtempSync(join(tmpdir(), 'panepilot-notes-outside-'))
    temporaryRoots.push(outside)
    symlinkSync(outside, join(projectFolder, '.panepilot'))
    try {
      await expect(metadata.createNote(project.id, 'Private')).rejects.toThrow(
        'must be a regular directory'
      )
      expect(existsSync(join(outside, 'notes', 'Private.md'))).toBe(false)
    } finally {
      store.close()
    }
  })
})
