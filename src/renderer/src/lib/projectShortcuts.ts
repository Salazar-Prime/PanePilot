import { useEffect, useRef, useState, type RefObject } from 'react'

export interface ProjectShortcutAction {
  key: string
  label: string
  active?: boolean
  run(): void | Promise<void>
}

export interface ProjectShortcutSession {
  id: string
  label: string
}

interface ShortcutEvent {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

interface ProjectShortcutsOptions {
  scopeId: string
  actions: ProjectShortcutAction[]
  sessions: ProjectShortcutSession[]
  activeSessionId: string | null
  onSelectSession(id: string): void | Promise<void>
}

const SHORTCUT_GUIDE_OPENED = 'panepilot:shortcut-guide-opened'

export interface ProjectShortcutsController {
  rootRef: RefObject<HTMLDivElement>
  open: boolean
  setOpen(open: boolean): void
  toggle(): void
}

export function isShortcutOverlayToggle(event: ShortcutEvent): boolean {
  return (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    (event.code === 'Slash' || event.key === '/')
  )
}

export function directSessionIndex(event: ShortcutEvent): number | null {
  if (
    !(event.metaKey || event.ctrlKey) ||
    event.altKey ||
    event.shiftKey
  ) {
    return null
  }
  const match = (event.code ?? '').match(/^Digit([1-9])$/)
  if (!match) return null
  return Number(match[1]) - 1
}

export function keyTipSessionIndex(event: ShortcutEvent): number | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  return /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : null
}

export function sessionCycleDirection(event: ShortcutEvent): -1 | 1 | null {
  const primaryBracket =
    (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey
  if (primaryBracket && event.code === 'BracketLeft') return -1
  if (primaryBracket && event.code === 'BracketRight') return 1
  if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    if (event.code === 'PageUp') return -1
    if (event.code === 'PageDown') return 1
  }
  return null
}

export function keyTipActionKey(event: ShortcutEvent): string | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  return /^[a-z]$/i.test(event.key) ? event.key.toLocaleLowerCase() : null
}

export function useProjectShortcuts(
  options: ProjectShortcutsOptions
): ProjectShortcutsController {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(false)
  }, [options.scopeId])

  useEffect(() => {
    function closeForAnotherWorkspace(event: Event) {
      if ((event as CustomEvent).detail !== rootRef.current) setOpen(false)
    }
    function closeOutside(event: PointerEvent) {
      if (
        open &&
        rootRef.current &&
        !rootRef.current.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }
    window.addEventListener(SHORTCUT_GUIDE_OPENED, closeForAnotherWorkspace)
    document.addEventListener('pointerdown', closeOutside, true)
    return () => {
      window.removeEventListener(SHORTCUT_GUIDE_OPENED, closeForAnotherWorkspace)
      document.removeEventListener('pointerdown', closeOutside, true)
    }
  }, [open])

  useEffect(() => {
    function run(action: () => void | Promise<void>) {
      try {
        Promise.resolve(action()).catch((caught: unknown) => {
          window.alert(caught instanceof Error ? caught.message : String(caught))
        })
      } catch (caught) {
        window.alert(caught instanceof Error ? caught.message : String(caught))
      }
    }

    function selectSession(index: number): boolean {
      const session = options.sessions[index]
      if (!session) return false
      setOpen(false)
      run(() => options.onSelectSession(session.id))
      return true
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.repeat ||
        event.isComposing ||
        !isActiveProjectWorkspace(rootRef.current)
      ) {
        return
      }

      if (isShortcutOverlayToggle(event)) {
        if (!open && hasBlockingDialog()) return
        event.preventDefault()
        event.stopPropagation()
        if (!open) announceShortcutOwner(rootRef.current)
        setOpen(!open)
        return
      }

      if (hasBlockingDialog()) return

      if (open && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        return
      }

      const directIndex = directSessionIndex(event)
      if (directIndex != null && selectSession(directIndex)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const direction = sessionCycleDirection(event)
      if (direction != null && options.sessions.length > 0) {
        const activeIndex = options.sessions.findIndex(
          (session) => session.id === options.activeSessionId
        )
        const nextIndex =
          activeIndex < 0
            ? 0
            : (activeIndex + direction + options.sessions.length) %
              options.sessions.length
        event.preventDefault()
        event.stopPropagation()
        selectSession(nextIndex)
        return
      }

      if (!open) return

      const keyTipIndex = keyTipSessionIndex(event)
      if (keyTipIndex != null && selectSession(keyTipIndex)) {
        event.preventDefault()
        event.stopPropagation()
        return
      }

      const actionKey = keyTipActionKey(event)
      const action = options.actions.find((candidate) => candidate.key === actionKey)
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      run(action.run)
    }

    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [open, options])

  return {
    rootRef,
    open,
    setOpen,
    toggle: () => {
      if (!open) announceShortcutOwner(rootRef.current)
      setOpen(!open)
    }
  }
}

function announceShortcutOwner(root: HTMLDivElement | null): void {
  window.dispatchEvent(new CustomEvent(SHORTCUT_GUIDE_OPENED, { detail: root }))
}

function hasBlockingDialog(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"]') != null
}

function isActiveProjectWorkspace(root: HTMLDivElement | null): boolean {
  if (!root || !root.isConnected) return false
  const workspaces = Array.from(
    document.querySelectorAll<HTMLDivElement>('.project-workspace')
  )
  if (workspaces.length <= 1) return workspaces[0] === root
  const focused = document.querySelector<HTMLDivElement>(
    '.workspace-pane.focused .project-workspace'
  )
  return focused ? focused === root : workspaces[0] === root
}
