import type { IDisposable, editor } from 'monaco-editor'

interface MonacoFileActionCallbacks {
  copyPath(): void | Promise<void>
  rename(): void | Promise<void>
  download(): void | Promise<void>
  showInFinder?: () => void | Promise<void>
}

export function addFileManagementActions(
  instance: editor.IStandaloneCodeEditor,
  callbacks: MonacoFileActionCallbacks
): IDisposable {
  const actions = [
    instance.addAction({
      id: 'panepilot.copy-file-path',
      label: 'Copy File Path',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2.1,
      run: callbacks.copyPath
    }),
    instance.addAction({
      id: 'panepilot.rename-file',
      label: 'Rename File…',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2.2,
      run: callbacks.rename
    }),
    instance.addAction({
      id: 'panepilot.download-file',
      label: 'Download File…',
      contextMenuGroupId: 'navigation',
      contextMenuOrder: 2.3,
      run: callbacks.download
    })
  ]
  if (callbacks.showInFinder) {
    actions.push(addShowInFinderAction(instance, callbacks.showInFinder))
  }
  return {
    dispose() {
      for (const action of actions) action.dispose()
    }
  }
}

export function addShowInFinderAction(
  instance: editor.IStandaloneCodeEditor,
  revealActiveFile: () => void | Promise<void>
): IDisposable {
  return instance.addAction({
    id: 'panepilot.show-in-finder',
    label: 'Show in Finder',
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 2.5,
    run: () => revealActiveFile()
  })
}
