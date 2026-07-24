import { describe, expect, it } from 'vitest'
import { codexStateFromPaneTitle } from '../src/main/codex-pane-status'

describe('Codex tmux pane status', () => {
  it('maps Codex run-state and action-required titles', () => {
    expect(codexStateFromPaneTitle('Thinking · 2/4 tasks', 'idle')).toBe('running')
    expect(codexStateFromPaneTitle('Working · validating build', 'idle')).toBe('running')
    expect(
      codexStateFromPaneTitle('Action required · 2/4 tasks', 'running')
    ).toBe('needs-input')
  })

  it('turns Ready into response-ready only after a running turn', () => {
    expect(codexStateFromPaneTitle('Ready · 4/4 tasks', 'running')).toBe(
      'response-ready'
    )
    expect(codexStateFromPaneTitle('Ready', 'idle')).toBeNull()
    expect(codexStateFromPaneTitle('Ready', 'needs-input')).toBe('needs-input')
  })

  it('ignores titles without PanePilot-managed Codex status items', () => {
    expect(codexStateFromPaneTitle('sal3000', 'running')).toBeNull()
  })
})
