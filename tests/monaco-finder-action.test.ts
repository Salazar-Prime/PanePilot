import type { IDisposable, editor } from 'monaco-editor'
import { describe, expect, it, vi } from 'vitest'
import {
  addFileManagementActions,
  addShowInFinderAction
} from '../src/renderer/src/lib/monacoFinderAction'

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

  it('registers copy, rename, download, and optional Finder actions together', async () => {
    const descriptors: editor.IActionDescriptor[] = []
    const disposables: IDisposable[] = []
    const instance = {
      addAction(next: editor.IActionDescriptor) {
        descriptors.push(next)
        const disposable: IDisposable = { dispose: vi.fn() }
        disposables.push(disposable)
        return disposable
      }
    } as unknown as editor.IStandaloneCodeEditor
    const callbacks = {
      copyPath: vi.fn(),
      rename: vi.fn(),
      download: vi.fn(),
      showInFinder: vi.fn()
    }

    const group = addFileManagementActions(instance, callbacks)

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual([
      'panepilot.copy-file-path',
      'panepilot.rename-file',
      'panepilot.download-file',
      'panepilot.show-in-finder'
    ])
    for (const descriptor of descriptors) await descriptor.run(instance)
    expect(callbacks.copyPath).toHaveBeenCalledOnce()
    expect(callbacks.rename).toHaveBeenCalledOnce()
    expect(callbacks.download).toHaveBeenCalledOnce()
    expect(callbacks.showInFinder).toHaveBeenCalledOnce()

    group.dispose()
    for (const disposable of disposables) {
      expect(disposable.dispose).toHaveBeenCalledOnce()
    }
  })
})
