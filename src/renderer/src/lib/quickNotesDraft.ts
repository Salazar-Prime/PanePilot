import type { QuickNotesContent, QuickNotesDocument } from '@shared/quickNotes'

export function quickNoteId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Serialize saves and drain later typing without replacing the current draft. */
export class QuickNotesDraft {
  value: QuickNotesContent | null = null
  private saved: QuickNotesContent | null = null
  private revision = 0
  private pending: Promise<void> | null = null

  constructor(private persist: (document: QuickNotesDocument) => Promise<QuickNotesDocument>) {}

  load(document: QuickNotesDocument): void {
    this.revision = document.revision
    this.value = this.saved = { thoughts: document.thoughts, items: document.items }
  }

  get dirty(): boolean { return this.value !== this.saved }

  flush(): Promise<void> {
    if (this.pending) return this.pending
    this.pending = this.saveLatest().finally(() => { this.pending = null })
    return this.pending
  }

  private async saveLatest(): Promise<void> {
    while (this.value && this.dirty) {
      const snapshot = this.value
      const result = await this.persist({ ...snapshot, revision: this.revision })
      this.revision = result.revision
      this.saved = snapshot
    }
  }
}
