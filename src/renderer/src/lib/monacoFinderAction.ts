import type { IDisposable, editor } from 'monaco-editor'

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
