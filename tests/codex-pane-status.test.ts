import { describe, expect, it } from 'vitest'
import {
  codexQueuedQuestionOnScreen,
  codexStateFromPaneTitle,
  codexStateFromPaneSnapshot,
  codexThreadReferenceFromPaneTitle
} from '../src/main/codex-pane-status'

describe('Codex tmux pane status', () => {
  it('recognizes the live queued-question footer, including multiple questions', () => {
    expect(codexQueuedQuestionOnScreen(
      '• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer'
    )).toBe(true)
    expect(codexQueuedQuestionOnScreen(
      '• Working\n• Queued follow-up inputs\n  ? 12 questions\n    shift + ← to answer'
    )).toBe(true)
  })

  it('does not mistake ordinary output or an old question for the live footer', () => {
    expect(codexQueuedQuestionOnScreen('Queued follow-up inputs')).toBe(false)
    expect(codexQueuedQuestionOnScreen(
      '• Queued follow-up inputs\n  ? 0 questions\n    shift+← to answer'
    )).toBe(false)
    expect(codexQueuedQuestionOnScreen(
      'Ran command: • Queued follow-up inputs\n? 1 question\nshift+← to answer'
    )).toBe(false)
    expect(codexQueuedQuestionOnScreen(
      '• Queued follow-up inputs\n? 1 question\nshift+← to answer\n' + 'other output\n'.repeat(12)
    )).toBe(false)
  })

  it('gives a live queued question priority over a Working title', () => {
    const question = '• Queued follow-up inputs\n  ? 1 question\n    shift+← to answer'
    expect(codexStateFromPaneSnapshot('Working', question, 'running')).toBe('needs-input')
    expect(codexStateFromPaneSnapshot('Working', null, 'needs-input')).toBeNull()
    expect(codexStateFromPaneSnapshot('Working', 'No question', 'needs-input')).toBe('running')
  })

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
