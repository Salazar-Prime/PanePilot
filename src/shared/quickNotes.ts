export interface QuickNoteItem { id: string; text: string; checked: boolean }
export interface QuickNotesContent { thoughts: string; items: QuickNoteItem[] }
export interface QuickNotesDocument extends QuickNotesContent { revision: number }

export const QUICK_NOTES_THOUGHT_LIMIT = 100_000
export const QUICK_NOTES_ITEM_LIMIT = 200
export const QUICK_NOTES_ITEM_TEXT_LIMIT = 1_000

/** Validate the complete bounded document at the trusted IPC boundary. */
export function validateQuickNotes(value: unknown): QuickNotesDocument {
  if (!value || typeof value !== 'object') throw new Error('Invalid quick notes.')
  const document = value as QuickNotesDocument
  if (!Number.isSafeInteger(document.revision) || document.revision < 0 ||
    typeof document.thoughts !== 'string' || document.thoughts.length > QUICK_NOTES_THOUGHT_LIMIT ||
    !Array.isArray(document.items) || document.items.length > QUICK_NOTES_ITEM_LIMIT) throw new Error('Quick notes exceed the supported limits.')
  const ids = new Set<string>()
  const items = document.items.map((item) => {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(item.id) || ids.has(item.id) ||
      typeof item.text !== 'string' || item.text.length > QUICK_NOTES_ITEM_TEXT_LIMIT || typeof item.checked !== 'boolean') throw new Error('Invalid checklist item.')
    ids.add(item.id)
    return { id: item.id, text: item.text, checked: item.checked }
  })
  return { revision: document.revision, thoughts: document.thoughts, items }
}
