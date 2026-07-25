export const MAX_CLIPBOARD_PASTE_BYTES = 2 * 1024 * 1024
const MAX_OSC52_CLIPBOARD_BYTES = 1024 * 1024

export function prepareClipboardPaste(text: string): string {
  return text.replaceAll('\0', '')
}

export function clipboardPasteFits(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_CLIPBOARD_PASTE_BYTES
}

export function decodeOsc52Clipboard(data: string): string | null {
  const separator = data.indexOf(';')
  if (separator < 0 || separator > 16) return null
  const encoded = data.slice(separator + 1).trim()
  if (
    !encoded ||
    encoded === '?' ||
    encoded.length > Math.ceil((MAX_OSC52_CLIPBOARD_BYTES * 4) / 3) + 8 ||
    !/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded)
  ) {
    return null
  }
  try {
    const binary = atob(encoded)
    if (binary.length > MAX_OSC52_CLIPBOARD_BYTES) return null
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes).replaceAll('\0', '')
  } catch {
    return null
  }
}
