const variants = {
  '1': '01 / Aperture',
  '2': '02 / Branch atlas',
  '3': '03 / Quiet ledger',
  '4': '04 / Merge lens'
}
const variant = new URLSearchParams(location.search).get('variant') || '1'
document.body.dataset.variant = variant in variants ? variant : '1'
document.getElementById('concept-name').textContent = variants[document.body.dataset.variant]

const modal = document.querySelector('.history-modal')
const timeline = document.getElementById('timeline-window')
const overview = document.getElementById('overview')
const overviewWindow = document.getElementById('overview-window')
const nodes = [...document.querySelectorAll('.commit-node')]
const paths = [...document.querySelectorAll('.timeline-lines path:not(.guide)')]
const toast = document.getElementById('toast')
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
let motionAnimate = null
let toastTimer = 0
let draggingOverview = false

// The preview uses the same Motion library proposed for the eventual React modal.
// It remains usable when the CDN is unavailable; only the enhanced motion falls back.
import('https://cdn.jsdelivr.net/npm/motion@14.3.0/+esm')
  .then(({ animate }) => {
    motionAnimate = animate
    if (!prefersReducedMotion.matches) {
      animate(modal, { opacity: [0, 1], y: [14, 0], scale: [0.985, 1] }, { duration: 0.42, ease: 'easeOut' })
    }
  })
  .catch(() => {})

function animateIfAllowed(element, values, options) {
  if (prefersReducedMotion.matches || !motionAnimate) return null
  return motionAnimate(element, values, options)
}

function updateOverview() {
  const maxScroll = Math.max(1, timeline.scrollWidth - timeline.clientWidth)
  const usable = overview.clientWidth - 6
  const width = Math.max(48, usable * (timeline.clientWidth / timeline.scrollWidth))
  const left = 3 + (usable - width) * (timeline.scrollLeft / maxScroll)
  overviewWindow.style.width = `${width}px`
  overviewWindow.style.left = `${left}px`
  overview.setAttribute('aria-valuenow', String(Math.round((timeline.scrollLeft / maxScroll) * 100)))
}

function scrollToOverviewPoint(clientX) {
  const rect = overview.getBoundingClientRect()
  const progress = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  timeline.scrollLeft = progress * (timeline.scrollWidth - timeline.clientWidth)
}

overview.addEventListener('pointerdown', (event) => {
  draggingOverview = true
  overview.setPointerCapture(event.pointerId)
  scrollToOverviewPoint(event.clientX)
})
overview.addEventListener('pointermove', (event) => {
  if (draggingOverview) scrollToOverviewPoint(event.clientX)
})
overview.addEventListener('pointerup', () => { draggingOverview = false })
overview.addEventListener('pointercancel', () => { draggingOverview = false })
overview.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  timeline.scrollLeft += event.key === 'ArrowLeft' ? -90 : 90
})
timeline.addEventListener('scroll', updateOverview, { passive: true })
timeline.addEventListener('wheel', (event) => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
  event.preventDefault()
  timeline.scrollLeft += event.deltaY
}, { passive: false })
document.getElementById('older').addEventListener('click', () => {
  timeline.scrollBy({ left: -360, behavior: prefersReducedMotion.matches ? 'instant' : 'smooth' })
})
document.getElementById('newer').addEventListener('click', () => {
  timeline.scrollBy({ left: 360, behavior: prefersReducedMotion.matches ? 'instant' : 'smooth' })
})

function fullSampleSha(shortHash) {
  return shortHash.repeat(6).slice(0, 40)
}

async function copySha(shortHash) {
  const sha = fullSampleSha(shortHash)
  let copied = false
  try {
    await navigator.clipboard.writeText(sha)
    copied = true
  } catch {
    const field = document.createElement('textarea')
    field.value = sha
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    copied = document.execCommand('copy')
    field.remove()
  }
  toast.textContent = copied ? `Copied full SHA · ${shortHash}` : `Copy unavailable · ${shortHash}`
  toast.style.opacity = '1'
  animateIfAllowed(toast, { opacity: [0, 1], y: [8, 0] }, { duration: 0.2, ease: 'easeOut' })
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    if (!animateIfAllowed(toast, { opacity: [1, 0], y: [0, 6] }, { duration: 0.22, ease: 'easeIn' })) {
      toast.style.opacity = '0'
    }
  }, 1900)
}

function selectCommit(node, copy = true) {
  for (const item of nodes) item.classList.toggle('selected', item === node)
  const branch = node.dataset.branch
  const names = { main: 'MAIN', feature: 'FEATURE/TERMINAL-UI', release: 'RELEASE/0.13', hotfix: 'HOTFIX/PDF' }
  document.getElementById('story-prefix').textContent = `${node.classList.contains('merge') ? 'MERGE COMMIT' : 'COMMIT'} · ${names[branch]}`
  document.getElementById('story-subject').textContent = node.dataset.subject
  document.getElementById('story-author').textContent = node.dataset.author
  document.getElementById('story-date').textContent = node.dataset.date
  document.getElementById('story-branch').textContent = names[branch].toLowerCase()
  document.getElementById('story-hash').textContent = node.dataset.hash
  const mergeLabel = document.getElementById('merge-label')
  mergeLabel.textContent = node.dataset.merge ? `↗ ${node.dataset.merge}` : '● Single commit'
  const mergeInsight = document.getElementById('merge-insight')
  mergeInsight.hidden = !node.dataset.merge
  if (node.dataset.merge) {
    const sourceBranch = { a48d2f1: 'feature/terminal-ui', '2a76bdf': 'release/0.13', '5da239b': 'hotfix/pdf' }
    document.getElementById('merge-source').textContent = sourceBranch[node.dataset.hash] || 'branch'
  }
  animateIfAllowed(document.querySelector('.story-left'), { opacity: [0.5, 1], y: [7, 0] }, { duration: 0.3, ease: 'easeOut' })
  if (copy) void copySha(node.dataset.hash)
}

for (const node of nodes) node.addEventListener('click', () => selectCommit(node))
document.getElementById('copy-hash').addEventListener('click', () => {
  const selected = document.querySelector('.commit-node.selected')
  if (selected) void copySha(selected.dataset.hash)
})

for (const chip of document.querySelectorAll('.branch-chip')) {
  chip.addEventListener('click', () => {
    const filter = chip.dataset.branch
    for (const item of document.querySelectorAll('.branch-chip')) {
      item.setAttribute('aria-pressed', String(item === chip))
    }
    for (const node of nodes) {
      const opacity = filter === 'all' || node.dataset.branch === filter ? 1 : 0.16
      if (!animateIfAllowed(node, { opacity }, { duration: 0.25, ease: 'easeOut' })) node.style.opacity = opacity
    }
    for (const path of paths) {
      const branch = path.classList[0].replace('-line', '')
      const opacity = filter === 'all' || branch === filter ? 1 : 0.12
      if (!animateIfAllowed(path, { opacity }, { duration: 0.25, ease: 'easeOut' })) path.style.opacity = opacity
    }
  })
}

function closeModal() {
  const animation = animateIfAllowed(modal, { opacity: [1, 0], y: [0, -10], scale: [1, 0.985] }, { duration: 0.23, ease: 'easeIn' })
  const finish = () => {
    modal.style.display = 'none'
    document.getElementById('reopen').style.display = 'block'
  }
  if (animation) animation.finished.then(finish)
  else finish()
}
document.getElementById('close').addEventListener('click', closeModal)
document.getElementById('reopen').addEventListener('click', () => {
  modal.style.display = 'block'
  document.getElementById('reopen').style.display = 'none'
  animateIfAllowed(modal, { opacity: [0, 1], y: [14, 0], scale: [0.985, 1] }, { duration: 0.36, ease: 'easeOut' })
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modal.style.display !== 'none') closeModal()
})

requestAnimationFrame(() => {
  timeline.scrollLeft = 270
  updateOverview()
  window.__mockupReady = true
})
