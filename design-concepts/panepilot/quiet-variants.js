/* Four browser-only Quiet studies. Every current control has an explicit route here;
   actions that require PanePilot's backend open a labelled design preview instead. */
const quietVariant = document.body.dataset.concept.replace('quiet-', '')
const quietApp = document.querySelector('.concept-app')
const quietWorkspace = document.querySelector('.main-workspace')
const quietTopTools = document.querySelector('.top-tools')

/* The Quiet follow-ups show all four conditional lifecycle counters separately. */
const quietQuestion = sessions.find((session) => session.id === 'draft')
quietQuestion.state = 'needs-input'
document.querySelector('[data-session="draft"] .state-dot').className = 'state-dot needs-input'
const quietBlockedSession = {
  id: 'package', name: 'Package audit', kind: 'Codex', state: 'blocked', glyph: '✳',
  heading: 'Package audit is blocked', summary: 'The signing credential is unavailable on this machine.',
  output: `<div class="terminal-line prompt-line"><span class="terminal-prompt">›</span><span>Check the release archive and its signature.</span></div><div class="terminal-gap"></div><div class="terminal-line"><span class="terminal-bullet blocked"></span><strong>Blocked</strong></div><div class="terminal-line indent">The local signing credential is not available.</div><div class="terminal-line indent">No release asset was changed or uploaded.</div>`
}
sessions.push(quietBlockedSession)
document.querySelector('.session-more').insertAdjacentHTML('beforebegin', sessionButton(quietBlockedSession))
document.querySelector('[data-session="package"] .session-tab-copy small').textContent = 'Codex · blocked'
const quietNeedsInputStatus = document.querySelector('[data-status="blocked"]')
quietNeedsInputStatus.dataset.status = 'needs-input'
quietNeedsInputStatus.classList.replace('status-blocked', 'status-needs-input')
quietNeedsInputStatus.querySelector('.state-dot').classList.replace('blocked', 'needs-input')
document.querySelector('.status-project-total').insertAdjacentHTML('beforebegin', statusButton('blocked', 1, 'blocked'))

const quietActions = [
  { id: 'new-terminal', label: 'New terminal', section: 'Create', glyph: 'terminal', detail: 'Open the Shell, Codex, or Claude launcher.' },
  { id: 'quick-chat', label: 'Quick Codex chats', section: 'Create', glyph: 'chat', detail: 'Open project-scoped quick chats.' },
  { id: 'new-project', label: 'New project', section: 'Create', glyph: 'plus', detail: 'Add a local or SSH project.' },
  { id: 'quick-notes', label: 'Quick Notes', section: 'Create', glyph: 'note', detail: 'Open the PanePilot-wide scratchpad.' },
  { id: 'subagents', label: 'Sub-agents', section: 'Inspect', glyph: 'git', detail: 'Show output for the active Codex terminal’s sub-agents.' },
  { id: 'git-pane', label: 'Git status and graph', section: 'Inspect', glyph: 'git', detail: 'Toggle the read-only Git pane.' },
  { id: 'repository', label: 'Open repository · Public', section: 'Inspect', glyph: 'git', detail: 'Open this project’s GitHub repository.' },
  { id: 'drive', label: 'Google Drive connection', section: 'Inspect', glyph: 'cloud', detail: 'Manage this project’s upload destination.' },
  { id: 'copy-path', label: 'Copy project path', section: 'Project', glyph: 'file', detail: 'Copy the full folder path shown in the title bar.' },
  { id: 'project-settings', label: 'Project settings', section: 'Project', glyph: 'grid', detail: 'Rename or configure this project.' },
  { id: 'sort-projects', label: 'Sort projects', section: 'Project', glyph: 'down', detail: 'Choose ordering for this machine’s sidebar group.' },
  { id: 'search-projects', label: 'Find a project', section: 'Project', glyph: 'search', detail: 'Search the local and SSH project list.' },
  { id: 'project-type', label: 'Project type · Terminal', section: 'Project', glyph: 'terminal', detail: 'Switch between Terminal and LaTeX projects.' },
  { id: 'split', label: 'Open right split', section: 'Workspace', glyph: 'grid', detail: 'Place another project beside this one.' },
  { id: 'close-split', label: 'Close right split', section: 'Workspace', glyph: 'collapse', detail: 'Return to one workspace pane.' },
  { id: 'swap-split', label: 'Swap split panes', section: 'Workspace', glyph: 'arrow', detail: 'Exchange the projects shown left and right.' },
  { id: 'sidebar', label: 'Show or hide sidebar', section: 'Workspace', glyph: 'collapse', detail: 'Keep the project list available without taking permanent space.' },
  { id: 'archive', label: 'Archived projects', section: 'Workspace', glyph: 'grid', detail: 'Browse and restore archived projects.' },
  { id: 'refresh-ssh', label: 'Refresh SSH hosts', section: 'Workspace', glyph: 'activity', detail: 'Reload connections from SSH configuration.' },
  { id: 'session-options', label: 'Terminal options', section: 'Session', glyph: 'more', detail: 'Rename, pin, force reload, transfer, archive, or remove the active session.' }
]

const quietViewButton = ([glyph, label]) => `<button class="quiet-view-button" data-quiet-view="${label}" title="Open ${label}" aria-label="Open ${label}">${icon(glyph, 15)}<span>${label}</span></button>`
const quietActionButton = (action) => `<button class="quiet-command" data-action="${action.id}" data-search="${action.label} ${action.detail} ${action.section}">${icon(action.glyph, 15)}<span><strong>${action.label}</strong><small>${action.detail}</small></span>${icon('arrow', 13)}</button>`
const quietActionGroups = [...new Set(quietActions.map((action) => action.section))].map((section) => `<section class="quiet-group" data-group="actions"><h3>${section}</h3>${quietActions.filter((action) => action.section === section).map(quietActionButton).join('')}</section>`).join('')

const quietAccessMarkup = {
  menu: `<div class="quiet-access-left"><button class="quiet-view-switch" data-open-panel="views" aria-expanded="false">${icon('grid', 15)} <span data-current-view>Terminals</span> ${icon('down', 12)}</button><span class="quiet-access-context">Release notes <i class="state-dot ready"></i></span></div><div class="quiet-access-right"><button data-action="new-terminal">${icon('plus', 15)} New terminal</button><button data-open-panel="tools" aria-expanded="false">All tools ${icon('down', 12)}</button></div>`,
  dock: `<div class="quiet-dock-label">PROJECT VIEWS</div><nav class="quiet-dock-views" aria-label="Project views">${viewItems.map(quietViewButton).join('')}</nav><button class="quiet-dock-more" data-open-panel="tools" aria-expanded="false">${icon('more', 16)}<span>Tools</span></button>`,
  drawer: `<span class="quiet-access-context"><i class="state-dot ready"></i> <b data-current-view>Terminals</b> <span class="quiet-context-divider">/</span> Release notes</span><button class="quiet-drawer-trigger" data-open-panel="all" aria-expanded="false">${icon('grid', 15)} Workspace controls <span class="quiet-trigger-count">7 views · 20 actions</span> ${icon('arrow', 14)}</button>`,
  palette: `<div class="quiet-access-context"><i class="state-dot ready"></i> <span data-current-view>Terminals</span> <span class="quiet-context-divider">/</span> Release notes</div><button class="quiet-palette-trigger" data-open-panel="all" aria-expanded="false">${icon('search', 15)} Search views & actions <kbd>⌘ K</kbd></button><button class="quiet-new-trigger" data-action="new-terminal">${icon('plus', 15)} New</button>`
}

quietTopTools.innerHTML = {
  menu: `<button class="quiet-top-tool" data-action="git-pane" title="Git status and graph">${icon('git', 15)}<span class="quiet-git-count">3</span></button><button class="quiet-top-tool" data-action="quick-notes" title="Quick Notes">${icon('note', 15)}</button><button class="quiet-top-tool quiet-top-text" data-open-panel="tools" aria-expanded="false">Tools ${icon('down', 12)}</button>`,
  dock: `<button class="quiet-top-tool" data-action="git-pane" title="Git status and graph">${icon('git', 15)}<span class="quiet-git-count">3</span></button><button class="quiet-top-tool" data-action="quick-notes" title="Quick Notes">${icon('note', 15)}</button><button class="quiet-top-tool quiet-top-text" data-open-panel="tools" aria-expanded="false">More ${icon('more', 14)}</button>`,
  drawer: `<button class="quiet-top-tool" data-action="git-pane" title="Git status and graph">${icon('git', 15)}<span class="quiet-git-count">3</span></button><button class="quiet-top-tool quiet-top-text" data-open-panel="all" aria-expanded="false">Controls ${icon('grid', 14)}</button>`,
  palette: `<button class="quiet-top-tool" data-action="git-pane" title="Git status and graph">${icon('git', 15)}<span class="quiet-git-count">3</span></button><button class="quiet-top-tool quiet-top-text" data-open-panel="all" aria-expanded="false">Search <kbd>⌘ K</kbd></button>`
}[quietVariant]

const originalPath = document.getElementById('top-path')
originalPath.outerHTML = `<button class="quiet-top-path" id="top-path" data-action="copy-path" title="Copy project path">${originalPath.textContent}</button>`
quietWorkspace.insertAdjacentHTML('afterbegin', `<nav class="quiet-access" aria-label="Quiet workspace controls">${quietAccessMarkup[quietVariant]}</nav>`)
quietApp.insertAdjacentHTML('beforeend', `<div class="quiet-scrim" hidden data-close-panel></div><section class="quiet-panel" hidden aria-label="Project controls" data-mode="all"><header class="quiet-panel-head"><div><span class="quiet-panel-overline">PANEPILOT / ${quietVariant.toUpperCase()}</span><h2>${quietVariant === 'palette' ? 'Go to anything' : quietVariant === 'drawer' ? 'Workspace controls' : 'Project controls'}</h2></div><button class="quiet-panel-close" data-close-panel aria-label="Close controls">×</button></header><label class="quiet-panel-search">${icon('search', 16)}<input type="search" placeholder="Find a view or action" aria-label="Find a view or action"><kbd>Esc</kbd></label><div class="quiet-panel-scroll"><section class="quiet-group" data-group="views"><h3>Project views</h3>${viewItems.map(([glyph, label]) => `<button class="quiet-command" data-quiet-view="${label}" data-search="Open ${label} Project views">${icon(glyph, 15)}<span><strong>${label}</strong><small>Open the ${label} workspace</small></span>${icon('arrow', 13)}</button>`).join('')}</section>${quietActionGroups}</div><footer class="quiet-panel-foot">Top-level views and toolbar actions are represented here. This is a static design study.</footer></section><div class="quiet-action-preview" hidden role="status"></div>`)

const quietPanel = document.querySelector('.quiet-panel')
const quietScrim = document.querySelector('.quiet-scrim')
const quietSearch = quietPanel.querySelector('input')
const quietPreview = document.querySelector('.quiet-action-preview')
let quietPanelTrigger = null
let quietCurrentView = 'Terminals'
let quietPreviewTimer = null

function quietSyncView(label) {
  quietCurrentView = label
  document.querySelectorAll('[data-current-view]').forEach((node) => { node.textContent = label })
  document.querySelectorAll('.quiet-dock-views [data-quiet-view]').forEach((node) => {
    node.classList.toggle('is-current', node.dataset.quietView === label)
    node.setAttribute('aria-current', node.dataset.quietView === label ? 'page' : 'false')
  })
}

function quietClosePanel() {
  if (quietPanel.hidden) return
  quietPanel.hidden = true
  quietScrim.hidden = true
  document.body.classList.remove('quiet-panel-open')
  document.querySelectorAll('[data-open-panel]').forEach((node) => node.setAttribute('aria-expanded', 'false'))
  quietPanelTrigger?.focus()
  quietPanelTrigger = null
}

function quietOpenPanel(mode, trigger) {
  if (!quietPanel.hidden && quietPanel.dataset.mode === mode) { quietClosePanel(); return }
  quietPanelTrigger = trigger
  quietPanel.dataset.mode = mode
  quietPanel.hidden = false
  quietScrim.hidden = ['menu', 'dock'].includes(quietVariant)
  document.body.classList.add('quiet-panel-open')
  document.querySelectorAll('[data-open-panel]').forEach((node) => node.setAttribute('aria-expanded', String(node === trigger)))
  quietSearch.value = ''
  quietFilter('')
  if (quietVariant === 'palette') quietSearch.focus()
  else quietPanel.querySelector(`${mode === 'tools' ? '.quiet-group[data-group="actions"]' : '.quiet-group[data-group="views"]'} .quiet-command:not([hidden])`)?.focus()
}

function quietFilter(value) {
  const query = value.trim().toLowerCase()
  quietPanel.querySelectorAll('.quiet-command').forEach((button) => {
    button.hidden = Boolean(query) && !button.dataset.search.toLowerCase().includes(query)
  })
  quietPanel.querySelectorAll('.quiet-group').forEach((group) => {
    group.hidden = !group.querySelector('.quiet-command:not([hidden])')
  })
}

function quietShowAction(id) {
  const action = quietActions.find((item) => item.id === id)
  if (!action) return
  if (id === 'git-pane') document.body.classList.toggle('rail-open')
  if (id === 'sidebar') document.body.classList.toggle('sidebar-collapsed')
  if (id === 'copy-path' && navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(document.getElementById('top-path').textContent).catch(() => {})
  }
  quietClosePanel()
  quietPreview.innerHTML = `<strong>${action.label}</strong><span>${action.detail} <em>Design preview only.</em></span><button aria-label="Dismiss preview">×</button>`
  quietPreview.hidden = false
  clearTimeout(quietPreviewTimer)
  quietPreviewTimer = setTimeout(() => { quietPreview.hidden = true }, 5500)
}

quietSearch.addEventListener('input', () => quietFilter(quietSearch.value))
document.addEventListener('click', (event) => {
  const button = event.target.closest('button')
  if (!button) {
    if (event.target.matches('[data-close-panel]')) quietClosePanel()
    return
  }
  if (button.dataset.openPanel) quietOpenPanel(button.dataset.openPanel, button)
  if (button.hasAttribute('data-close-panel')) quietClosePanel()
  if (button.dataset.quietView) {
    activateView(button.dataset.quietView)
    quietSyncView(button.dataset.quietView)
    quietClosePanel()
  }
  if (button.dataset.action) quietShowAction(button.dataset.action)
  if (button.closest('.quiet-action-preview')) quietPreview.hidden = true
  if (button.dataset.session || button.dataset.jumpSession) quietSyncView('Terminals')
  if (button.classList.contains('app-type')) quietOpenPanel('tools', button)
  if (button.closest('.side-footer')) quietShowAction(button.textContent.includes('New project') ? 'new-project' : 'archive')
  if (button.classList.contains('terminal-menu')) quietShowAction('session-options')
})

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    quietOpenPanel('all', document.querySelector('.quiet-palette-trigger, .quiet-drawer-trigger, .quiet-top-text'))
  }
  if (event.key === 'Escape') quietClosePanel()
  if (!quietPanel.hidden && event.key === 'Enter' && document.activeElement === quietSearch) {
    const first = quietPanel.querySelector('.quiet-command:not([hidden])')
    if (first) { event.preventDefault(); first.click() }
  }
})

quietSyncView('Terminals')
const quietNarrow = window.matchMedia('(max-width: 700px)')
if (quietNarrow.matches) document.body.classList.add('sidebar-collapsed')
quietNarrow.addEventListener('change', (event) => {
  if (event.matches) document.body.classList.add('sidebar-collapsed')
})
