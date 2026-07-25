import { describe, expect, it } from 'vitest'
import {
  codexStateFromPaneTitle,
  codexThreadReferenceFromPaneTitle
} from '../src/main/codex-pane-status'

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

  it('reads full and title-truncated Codex thread IDs', () => {
    expect(
      codexThreadReferenceFromPaneTitle(
        'Ready | 019f9718-2e61-7e10-b9f1-347710ba035c'
      )
    ).toBe('019f9718-2e61-7e10-b9f1-347710ba035c')
    expect(
      codexThreadReferenceFromPaneTitle(
        'Working | 2/4 tasks | 019f9718-2e61-7e10-b9f1-34771...'
      )
    ).toBe('019f9718-2e61-7e10-b9f1-34771')
  })
})
