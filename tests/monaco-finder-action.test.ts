import type { IDisposable, editor } from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import { addShowInFinderAction } from '../src/renderer/src/lib/monacoFinderAction'

describe('Monaco Finder action', () => {
  it('registers a native editor context-menu action', async () => {
    let descriptor: editor.IActionDescriptor | null = null
    const disposable: IDisposable = { dispose: vi.fn() }
    const instance = {
      addAction(next: editor.IActionDescriptor) {
        descriptor = next
        return disposable
      }
    } as unknown as editor.IStandaloneCodeEditor
    const reveal = vi.fn()

    expect(addShowInFinderAction(instance, reveal)).toBe(disposable)
    expect(descriptor).toMatchObject({
      id: 'panepilot.show-in-finder',
      label: 'Show in Finder',
      contextMenuGroupId: 'navigation'
    })

    await descriptor!.run(instance)
    expect(reveal).toHaveBeenCalledOnce()
  })
})
