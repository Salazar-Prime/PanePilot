import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  noteProjectPath,
  projectNotePathFromLink
} from '../src/renderer/src/lib/noteMarkdown'

describe('Notes Markdown preview', () => {
  it('uses the shared sanitized preview with Preview and Source controls', () => {
    const component = readFileSync(
      join(
        process.cwd(),
        'src/renderer/src/components/NotesPanel.tsx'
      ),
      'utf8'
    )

    expect(component).toContain('<MarkdownPreview')
    expect(component).toContain('aria-label="Markdown note view"')
    expect(component).toContain("viewModes[note.path] ?? 'preview'")
    expect(component).toContain('content={draft}')
  })

  it('renders note-relative resources from their authoritative project path', () => {
    expect(noteProjectPath('decisions.md')).toBe(
      '.panepilot/notes/decisions.md'
    )
  })

  it('routes links to known notes back into Notes', () => {
    const notes = ['decisions.md', 'release.md']

    expect(
      projectNotePathFromLink('.panepilot/notes/release.md', notes)
    ).toBe('release.md')
    expect(projectNotePathFromLink('README.md', notes)).toBeNull()
    expect(
      projectNotePathFromLink('.panepilot/notes/missing.md', notes)
    ).toBeNull()
  })
})
