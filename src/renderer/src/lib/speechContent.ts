export interface SpeechContentSnapshot {
  selectedText: string
  visibleText: string
}

type SpeechContentProvider = () => SpeechContentSnapshot

const providers = new Map<string, SpeechContentProvider>()

export function registerSpeechContent(
  key: string,
  provider: SpeechContentProvider
): () => void {
  providers.set(key, provider)
  return () => {
    if (providers.get(key) === provider) providers.delete(key)
  }
}

export function speechContentFor(key: string | null): SpeechContentSnapshot | null {
  if (!key) return null
  return providers.get(key)?.() ?? null
}

export function selectedDocumentText(): string {
  const active = document.activeElement
  if (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement &&
      ['text', 'search', 'url', 'email', 'tel'].includes(active.type))
  ) {
    const start = active.selectionStart ?? 0
    const end = active.selectionEnd ?? 0
    if (end > start) return active.value.slice(start, end)
  }
  return window.getSelection()?.toString().trim() ?? ''
}
