import type { LaunchProfile } from '@shared/types'

/** On macOS Option punctuation normally becomes ≤/≥ instead of terminal Meta.
 * Translate only Codex's two reasoning keys; leave other Option text input alone. */
export function terminalReasoningShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'isComposing'>,
  profile: LaunchProfile,
  isMac: boolean
): string | null {
  if (!isMac || profile !== 'codex' || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing || event.key === 'Dead') return null
  if (event.code === 'Comma' || event.key === ',') return '\x1b,'
  if (event.code === 'Period' || event.key === '.') return '\x1b.'
  return null
}
