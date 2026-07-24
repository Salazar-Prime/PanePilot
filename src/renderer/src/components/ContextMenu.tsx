import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface ContextMenuItem {
  id: string
  label: string
  icon: ReactNode
  disabled?: boolean
  danger?: boolean
  separatorBefore?: boolean
  action(): void | Promise<void>
}

interface Props {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose(): void
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    function closeOnPointer(event: MouseEvent) {
      const target = event.target as HTMLElement
      if (!target.closest('.context-menu')) onClose()
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', closeOnPointer)
    window.addEventListener('blur', onClose)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOnPointer)
      window.removeEventListener('blur', onClose)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose])

  const left = Math.max(8, Math.min(x, window.innerWidth - 220))
  const estimatedHeight = items.length * 32 + items.filter((item) => item.separatorBefore).length * 7
  const top = Math.max(8, Math.min(y, window.innerHeight - estimatedHeight - 12))

  return createPortal(
    <div
      className="context-menu"
      role="menu"
      style={{ left, top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.id} className={item.separatorBefore ? 'context-menu-separated' : ''}>
          <button
            role="menuitem"
            disabled={item.disabled}
            className={item.danger ? 'danger-text' : ''}
            onClick={() => {
              onClose()
              void Promise.resolve(item.action()).catch((caught: unknown) => {
                window.alert(caught instanceof Error ? caught.message : String(caught))
              })
            }}
          >
            {item.icon}
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body
  )
}
