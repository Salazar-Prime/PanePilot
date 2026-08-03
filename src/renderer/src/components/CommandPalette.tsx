import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, CornerDownLeft, Search } from 'lucide-react'
import {
  filterCommands,
  type SearchableCommand
} from '../lib/commandPalette'

export interface CommandPaletteCommand extends SearchableCommand {
  section: string
  icon: ReactNode
  shortcut?: string
  action(): void
}

interface Props {
  open: boolean
  commands: CommandPaletteCommand[]
  onClose(): void
}

export function CommandPalette({ open, commands, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const results = useMemo(
    () => filterCommands(commands, query).slice(0, 80),
    [commands, query]
  )

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  useEffect(() => {
    setSelectedIndex((current) => Math.min(current, Math.max(0, results.length - 1)))
  }, [results.length])

  if (!open) return null

  function run(command: CommandPaletteCommand) {
    onClose()
    window.queueMicrotask(command.action)
  }

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="PanePilot commands"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="command-search-row">
          <Search size={17} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSelectedIndex((current) =>
                  results.length === 0 ? 0 : (current + 1) % results.length
                )
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSelectedIndex((current) =>
                  results.length === 0
                    ? 0
                    : (current - 1 + results.length) % results.length
                )
              } else if (event.key === 'Enter' && results[selectedIndex]) {
                event.preventDefault()
                run(results[selectedIndex])
              }
            }}
            placeholder="Jump to a project, terminal, or action…"
            aria-label="Search commands"
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-results" role="listbox">
          {results.length === 0 ? (
            <div className="command-empty">
              <Search size={19} />
              <span>No PanePilot command matches “{query.trim()}”.</span>
            </div>
          ) : (
            results.map((command, index) => {
              const previousSection = results[index - 1]?.section
              return (
                <div key={command.id} className="command-result-block">
                  {command.section !== previousSection && (
                    <div className="command-section-label">{command.section}</div>
                  )}
                  <button
                    className={index === selectedIndex ? 'selected' : ''}
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseMove={() => setSelectedIndex(index)}
                    onClick={() => run(command)}
                  >
                    <span className="command-icon">{command.icon}</span>
                    <span className="command-copy">
                      <strong>{command.label}</strong>
                      {command.detail && <small>{command.detail}</small>}
                    </span>
                    {command.shortcut && <kbd>{command.shortcut}</kbd>}
                  </button>
                </div>
              )
            })
          )}
        </div>
        <footer className="command-palette-footer">
          <span><ArrowUp size={11} /><ArrowDown size={11} /> navigate</span>
          <span><CornerDownLeft size={12} /> open</span>
          <strong>PanePilot</strong>
        </footer>
      </section>
    </div>
  )
}
