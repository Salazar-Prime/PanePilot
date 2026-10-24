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

  it.each([
    ['? 1 question · 12s', '⇧← to answer'],
    ['? 1 question · 12s', 'shift+← to answer'],
    ['? 1 question', '⇧← to answer'],
    ['? 2 questions · 1m 12s', '⇧ ← to answer'],
    ['? 12 questions · 1h 2m 3s', 'shift + ← to answer'],
    ['? 1 question · 0s', '⇧+← to answer'],
    ['? 1 question · 1.5s', '⇧← to answer']
  ])('recognizes timed/glyph footer variants: %s / %s', (count, shortcut) => {
    const footer = `• Queued follow-up inputs\n  ${count}\n    ${shortcut}`
    expect(codexQueuedQuestionOnScreen(footer)).toBe(true)
    expect(codexStateFromPaneSnapshot('Working', footer, 'running')).toBe('needs-input')
    expect(codexStateFromPaneSnapshot('Ready', footer, 'response-ready')).toBe('needs-input')
  })

  it.each([
    ['? 0 questions · 12s', '⇧← to answer'],
    ['? 1 question · waiting for a response', '⇧← to answer'],
    ['? 1 question · 12s', '⇧→ to answer'],
    ['? 1 question · 12s', '⇧← to select'],
    ['? 1 question · 12s', 'Ctrl+← to answer'],
    ['? 1 question · 12s copied from a log', '⇧← to answer']
  ])('rejects non-live footer variants: %s / %s', (count, shortcut) => {
    expect(codexQueuedQuestionOnScreen(`• Queued follow-up inputs\n${count}\n${shortcut}`)).toBe(false)
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

  it.each([
    '• Queued follow-up inputs\n? 1 question\nshift+← to answer',
    '• Queued follow-up inputs\n? 1 question · 12s\n⇧← to answer'
  ])('limits the complete footer to the last eight rendered rows: %s', (footer) => {
    const laterRows = (count: number) => Array.from({ length: count }, () => 'New output').join('\n')
    expect(codexQueuedQuestionOnScreen(`${footer}\n${laterRows(5)}`)).toBe(true)
    expect(codexQueuedQuestionOnScreen(`${footer}\n${laterRows(5)}\n`)).toBe(false)
    expect(codexQueuedQuestionOnScreen(`${footer}\n${laterRows(6)}\n`)).toBe(false)
    // Blank terminal rows still occupy space; do not pull an old prompt down
    // into the footer by trimming away all trailing whitespace.
    expect(codexQueuedQuestionOnScreen(`${footer}${'\n'.repeat(10)}`)).toBe(false)
    expect(codexQueuedQuestionOnScreen(`${footer}\n› Answer here\nReady\n`)).toBe(true)
  })

  it('clears a queued alert when a valid snapshot no longer contains its footer', () => {
    expect(codexStateFromPaneSnapshot('Ready', '› Ask anything', 'needs-input')).toBe('response-ready')
    expect(codexStateFromPaneSnapshot('', '› Ask anything', 'needs-input')).toBe('idle')
    expect(codexStateFromPaneSnapshot('Working', '', 'needs-input')).toBe('running')
    expect(codexStateFromPaneSnapshot('Ready', null, 'needs-input')).toBeNull()
    expect(codexStateFromPaneSnapshot('Ready', undefined, 'needs-input')).toBeNull()
    expect(codexStateFromPaneSnapshot('Approval required', 'Confirm command', 'needs-input')).toBe('needs-input')
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
