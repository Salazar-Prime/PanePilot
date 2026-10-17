import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('new project and agent launcher defaults', () => {
  it('focuses the project path field and keeps terminal focus from stealing it', () => {
    const source = readFileSync('src/renderer/src/components/NewProjectDialog.tsx', 'utf8')
    expect(source).toContain("document.addEventListener('focusin', keepFocusInDialog)")
    expect(source).toContain('folderInputRef.current?.focus()')
    expect(source.match(/ref=\{folderInputRef\}/g)).toHaveLength(2)
  })

  it('focuses the new terminal name and keeps the background terminal from stealing it', () => {
    const source = readFileSync('src/renderer/src/components/TerminalLauncher.tsx', 'utf8')
    expect(source).toContain('ref={dialogRef}')
    expect(source).toContain('ref={nameInputRef}')
    expect(source).toContain('autoFocus')
    expect(source).toContain('nameInputRef.current?.focus()')
    expect(source).toContain("document.addEventListener('focusin', keepFocusInDialog)")
    expect(source).toContain("document.removeEventListener('focusin', keepFocusInDialog)")
    expect(source).toContain('if (!dialogRef.current.contains(event.target))')
  })

  it('starts new Codex and LaTeX chats with visible permission bypass checked', () => {
    for (const component of ['TerminalLauncher', 'LatexChatLauncher']) {
      const source = readFileSync(`src/renderer/src/components/${component}.tsx`, 'utf8')
      expect(source).toContain('const [dangerousMode, setDangerousMode] = useState(true)')
      expect(source).toContain('checked={dangerousMode}')
      expect(source).toContain('Disable permission checks')
    }
    const source = readFileSync('src/renderer/src/components/TerminalLauncher.tsx', 'utf8')
    expect(source).toContain('dangerousMode: isAgent && dangerousMode')
  })

  it('selects a new terminal only after its project refresh and launcher dismissal', () => {
    const source = readFileSync('src/renderer/src/components/TerminalProjectWorkspace.tsx', 'utf8')
    expect(source).toContain('pendingStartedSessionId.current = session.id')
    expect(source).toContain('if (showLauncher || !terminalSessions.some((session) => session.id === pending)) return')
    expect(source).toContain('onSelectSession(pending)')
  })
})
