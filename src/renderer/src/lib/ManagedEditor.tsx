import RawEditor, { type EditorProps } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { useEffect, useLayoutEffect, useRef } from 'react'
import { EditorModelPool } from './editorModelPool'

const models = new EditorModelPool<editor.ITextModel, editor.ICodeEditorViewState>()

export function discardEditorDraft(path: string, savedValue: string): void {
  models.discard(path, savedValue)
}

export function forgetEditorModel(path: string, owner?: editor.IStandaloneCodeEditor | null): void { models.forget(path, owner ?? undefined) }

type Props = EditorProps & { path: string; savedValue: string }

/** The wrapper's implicit model/view maps are replaced with one bounded owner. */
export function ManagedEditor(props: Props) {
  return <EditorInstance key={props.path} {...props} />
}

function EditorInstance({ savedValue, onMount, ...props }: Props) {
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const cancelRestoreRef = useRef<() => void>(() => {})
  const previousSaved = useRef(savedValue)
  const current = useRef({ savedValue, onMount, onChange: props.onChange })
  current.current = { savedValue, onMount, onChange: props.onChange }
  const key = props.path

  useEffect(() => {
    if (previousSaved.current !== savedValue) {
      models.saved(key, savedValue)
      previousSaved.current = savedValue
    }
  }, [key, savedValue])

  useLayoutEffect(() => () => {
    const instance = editorRef.current
    cancelRestoreRef.current()
    if (instance) models.release(key, instance.saveViewState(), instance)
    editorRef.current = null
  }, [key])

  return <RawEditor {...props} keepCurrentModel saveViewState={false} onMount={(instance, monaco) => {
    editorRef.current = instance
    const model = instance.getModel()!
    const view = models.acquire(key, model, current.current.savedValue, props.value ?? '', instance)
    if (view) instance.restoreViewState(view)
    if (view && view.viewState.scrollLeft > 0) {
      // Horizontal range is measured after the restored vertical slice paints.
      // Only finish that horizontal restoration if no caller/user navigated.
      const selection = instance.getSelection()
      const top = instance.getScrollTop()
      let frame = 0
      let canceled = false
      const node = instance.getDomNode()
      const cancel = () => {
        canceled = true
        cancelAnimationFrame(frame)
        mouse.dispose()
        keyboard.dispose()
        content.dispose()
        node?.removeEventListener('wheel', cancel)
      }
      const mouse = instance.onMouseDown(cancel)
      const keyboard = instance.onKeyDown(cancel)
      const finishHorizontal = () => {
        if (canceled) return
        if (editorRef.current !== instance || instance.getScrollTop() !== top || !instance.getSelection()?.equalsSelection(selection!)) { cancel(); return }
        instance.setScrollPosition({ scrollLeft: view.viewState.scrollLeft }, 1)
        if (Math.abs(instance.getScrollLeft() - view.viewState.scrollLeft) <= 1) cancel()
      }
      const content = instance.onDidContentSizeChange(finishHorizontal)
      node?.addEventListener('wheel', cancel, { passive: true })
      cancelRestoreRef.current = cancel
      frame = requestAnimationFrame(() => {
        if (canceled) return
        instance.render(true)
        frame = requestAnimationFrame(() => {
          finishHorizontal()
        })
      })
    }
    current.current.onMount?.(instance, monaco)
    // A second pane can mount with an older React snapshot while the shared
    // model already contains typing. Adopt it, never overwrite the live draft.
    if (model.getValue() !== props.value && current.current.onChange) {
      current.current.onChange(model.getValue(), {
        changes: [], eol: model.getEOL(), versionId: model.getVersionId(),
        isUndoing: false, isRedoing: false, isFlush: false, isEolChange: false,
        detailedReasonsChangeLengths: []
      })
    }
  }} />
}
