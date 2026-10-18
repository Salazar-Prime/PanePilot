import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Check, ChevronDown, ChevronLeft, ChevronRight, GitBranch, Search } from 'lucide-react'
import type { GitBranchRef } from '@shared/types'
import { gitBranchKey, matchingGitBranches } from '../lib/gitBranches'
import { useModalEscape } from '../lib/modalEscape'

interface Props {
  branches: GitBranchRef[]
  selectedKey: string | null
  currentBranch: string | null
  colorFor(branch: GitBranchRef, index: number): string
  onSelect(branch: GitBranchRef | null): void
}

export function GitBranchBar({ branches, selectedKey, currentBranch, colorFor, onSelect }: Props) {
  const reducedMotion = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLElement>(null)
  const pickerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const resultsRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ left: false, right: false })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const resultsId = useId()
  const matches = useMemo(() => matchingGitBranches(branches, query), [branches, query])
  const results = matches.slice(0, 200)
  const selected = branches.find((branch) => gitBranchKey(branch) === selectedKey)

  const measure = useCallback(() => {
    const list = listRef.current
    if (!list) return
    const next = { left: list.scrollLeft > 1, right: list.scrollLeft + list.clientWidth < list.scrollWidth - 1 }
    setScroll((current) => current.left === next.left && current.right === next.right ? current : next)
  }, [])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const observer = new ResizeObserver(() => {
      const active = list.querySelector<HTMLElement>('[aria-pressed="true"]')
      if (active && (active.offsetLeft < list.scrollLeft || active.offsetLeft + active.offsetWidth > list.scrollLeft + list.clientWidth)) {
        list.scrollLeft = active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2
      }
      measure()
    })
    observer.observe(list)
    measure()
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || list.scrollWidth <= list.clientWidth || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      event.preventDefault()
      list.scrollLeft += event.deltaY
    }
    list.addEventListener('wheel', wheel, { passive: false })
    return () => { observer.disconnect(); list.removeEventListener('wheel', wheel) }
  }, [measure, branches])

  useLayoutEffect(() => {
    const list = listRef.current
    if (!list) return
    const active = list.querySelector<HTMLElement>('[aria-pressed="true"]')
    if (active) {
      // Layout offsets stay accurate while the glass modal is animating its
      // scale; viewport rects would multiply distant branch offsets by it.
      list.scrollTo({ left: active.offsetLeft - (list.clientWidth - active.offsetWidth) / 2, behavior: reducedMotion ? 'auto' : 'smooth' })
    } else if (!selectedKey) list.scrollLeft = 0
    measure()
  }, [selectedKey, branches, measure, reducedMotion])

  function closePicker(restoreFocus = false) {
    setPickerOpen(false)
    if (restoreFocus) pickerRef.current?.focus({ preventScroll: true })
  }
  useModalEscape(() => closePicker(true), pickerOpen)

  useEffect(() => {
    if (!pickerOpen) return
    searchRef.current?.focus()
    const outside = (event: Event) => { if (!rootRef.current?.contains(event.target as Node)) closePicker() }
    const blur = () => closePicker()
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
      window.removeEventListener('blur', blur)
    }
  }, [pickerOpen])

  useEffect(() => {
    if (!pickerOpen) return
    const list = resultsRef.current
    const option = list?.children[highlighted] as HTMLElement | undefined
    if (!list || !option) return
    const top = option.offsetTop
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + option.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + option.offsetHeight - list.clientHeight
  }, [pickerOpen, highlighted, query])

  function choose(branch: GitBranchRef) {
    closePicker(true)
    onSelect(branch)
  }

  function scrollBy(direction: -1 | 1) {
    const list = listRef.current
    list?.scrollBy({ left: direction * Math.max(100, list.clientWidth * 0.7), behavior: reducedMotion ? 'auto' : 'smooth' })
  }

  const overflow = scroll.left || scroll.right
  return <div className="gh-branch-navigation" ref={rootRef}>
    <span className="gh-branch-label"><GitBranch size={13} /> Branches</span>
    <button className={`gh-branch-chip gh-all-branches ${selectedKey === null ? 'active' : ''}`}
      aria-pressed={selectedKey === null} onClick={() => { closePicker(); onSelect(null) }}><i />All</button>
    <div className={`gh-branch-scrollport${overflow ? ' overflowing' : ''}`}>
      {overflow && <button className="gh-branch-scroll" aria-label="Scroll branches left" disabled={!scroll.left} onClick={() => scrollBy(-1)}><ChevronLeft size={14} /></button>}
      <nav className="gh-branch-list" aria-label="Focus branch history" ref={listRef} onScroll={measure}>
        {branches.map((branch, index) => <button key={gitBranchKey(branch)}
          className={`gh-branch-chip ${selectedKey === gitBranchKey(branch) ? 'active' : ''} ${branch.remote ? 'remote' : ''}`}
          aria-pressed={selectedKey === gitBranchKey(branch)}
          title={`${branch.remote ? 'Remote' : 'Local'} branch: ${branch.name}${!branch.remote && branch.name === currentBranch ? ' · current branch' : ''}`}
          style={{ '--gh-branch-color': colorFor(branch, index) } as CSSProperties} onClick={() => { closePicker(); onSelect(branch) }}>
          <i /><span className="gh-branch-name">{branch.name}</span>
          {!branch.remote && branch.name === currentBranch && <span className="gh-head-mark">HEAD</span>}
        </button>)}
      </nav>
      {overflow && <button className="gh-branch-scroll" aria-label="Scroll branches right" disabled={!scroll.right} onClick={() => scrollBy(1)}><ChevronRight size={14} /></button>}
    </div>
    <button className="gh-branch-picker-trigger" ref={pickerRef} aria-label="Find a branch" aria-expanded={pickerOpen}
      aria-controls={resultsId} title={`Find a branch · ${branches.length} branches${selected ? ` · ${selected.name}` : ''}`}
      onClick={() => {
        if (pickerOpen) closePicker()
        else {
          const index = branches.findIndex((branch) => gitBranchKey(branch) === selectedKey)
          setQuery('')
          setHighlighted(index >= 0 && index < 200 ? index : 0)
          setPickerOpen(true)
        }
      }}><Search size={13} /><ChevronDown size={10} /></button>
    <AnimatePresence>
      {pickerOpen && <motion.div className="gh-branch-picker" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }} transition={{ duration: reducedMotion ? 0 : 0.14 }}>
        <label className="gh-branch-search"><Search size={13} />
          <input ref={searchRef} value={query} placeholder="Find local or remote branch…" aria-label="Search branches" role="combobox"
            aria-expanded={true} aria-controls={resultsId} aria-autocomplete="list"
            aria-activedescendant={results[highlighted] ? `${resultsId}-${highlighted}` : undefined}
            onChange={(event) => { setQuery(event.target.value); setHighlighted(0) }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                setHighlighted((current) => Math.max(0, Math.min(results.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))))
              } else if (event.key === 'Enter') {
                event.preventDefault()
                if (results[highlighted]) choose(results[highlighted])
              }
            }} />
        </label>
        <div className="gh-branch-results" id={resultsId} role="listbox" aria-label="Matching branches" ref={resultsRef}>
          {results.map((branch, index) => <button role="option" id={`${resultsId}-${index}`} key={gitBranchKey(branch)}
            tabIndex={-1}
            aria-selected={selectedKey === gitBranchKey(branch)} className={index === highlighted ? 'highlighted' : ''}
            title={branch.name} onClick={() => choose(branch)} onPointerMove={() => setHighlighted(index)}>
            <GitBranch size={12} /><span>{branch.name}</span><small>{branch.remote ? 'Remote' : 'Local'}</small>
            {selectedKey === gitBranchKey(branch) && <Check size={12} />}
          </button>)}
        </div>
        <div className="gh-branch-result-count" role="status">{matches.length === 0 ? 'No matching branches' : matches.length > 200 ? `Showing 200 of ${matches.length} branches. Type to narrow.` : `${matches.length} branch${matches.length === 1 ? '' : 'es'}`}</div>
      </motion.div>}
    </AnimatePresence>
  </div>
}
