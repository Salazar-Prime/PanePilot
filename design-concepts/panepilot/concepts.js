/* Browser-only PanePilot layout studies. No application data or network calls. */
const drawings = {
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  actions: '<path d="m8 3 1.5 5.5L15 10l-5.5 1.5L8 17l-1.5-5.5L1 10l5.5-1.5L8 3ZM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15Z"/>',
  chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-4-.9L3 21l1.9-5.5A8.5 8.5 0 1 1 21 11.5Z"/>',
  note: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  file: '<path d="M7 3h7l5 5v13H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M14 3v6h5"/>',
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  git: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><path d="M6 8v8M8 6h8a2 2 0 0 1 2 2v2a5 5 0 0 1-5 5H6"/>',
  cloud: '<path d="M7 18h12a4 4 0 0 0 .1-8A7 7 0 0 0 5.5 9 4.5 4.5 0 0 0 7 18Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  collapse: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m8-11-3 3 3 3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  shield: '<path d="M12 2 4 5v6c0 5 3.5 8.5 8 11 4.5-2.5 8-6 8-11V5l-8-3Z"/><path d="M12 8v5m0 3h.01"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  pin: '<path d="M9 3h6l-1 6 4 4v2H6v-2l4-4-1-6ZM12 15v6"/>',
  command: '<path d="M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2V7Z"/>'
}

function icon(name, size = 16) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${drawings[name]}</svg>`
}

const concepts = {
  compass: { number: '01', name: 'Compass', previous: '05-quiet.html', next: '02-harbor.html' },
  harbor: { number: '02', name: 'Harbor', previous: '01-compass.html', next: '03-orbit.html' },
  orbit: { number: '03', name: 'Orbit', previous: '02-harbor.html', next: '04-ledger.html' },
  ledger: { number: '04', name: 'Ledger', previous: '03-orbit.html', next: '05-quiet.html' },
  quiet: { number: '05', name: 'Quiet', previous: '04-ledger.html', next: '01-compass.html' }
}

const sessions = [
  { id: 'release', name: 'Release notes', kind: 'Codex', state: 'ready', glyph: '✳', heading: 'Release notes are ready', summary: 'A finished answer, waiting for your review.', output: `<div class="terminal-line prompt-line"><span class="terminal-prompt">›</span><span>Prepare a concise v0.10 release summary and check the build.</span></div><div class="terminal-gap"></div><div class="terminal-line"><span class="terminal-bullet ready"></span><strong>Done.</strong> The release summary is drafted and the production build passed.</div><div class="terminal-line indent"><span class="term-muted">Changed</span> <span class="term-path">docs/releases/v0.10.md</span></div><div class="terminal-line indent"><span class="term-muted">Verified</span> <span class="term-code">npm run typecheck</span> <span class="term-muted">and</span> <span class="term-code">npm run build</span></div><div class="terminal-gap"></div><div class="terminal-line"><span class="term-muted">Summary</span></div><div class="terminal-line indent">• Faster project switching with retained terminal surfaces</div><div class="terminal-line indent">• A clearer Git status and commit history pane</div><div class="terminal-line indent">• Better recovery for remote Codex sessions</div><div class="terminal-gap"></div><div class="terminal-line"><span class="term-muted">Ready for your review. No release was published.</span></div>` },
  { id: 'tests', name: 'Test runner', kind: 'Terminal', state: 'working', glyph: '›_', heading: 'Tests are running', summary: 'Local shell · 43 of 48 suites complete.', output: `<div class="terminal-line prompt-line"><span class="terminal-prompt">$</span><span>npm test</span></div><div class="terminal-gap"></div><div class="terminal-line"><span class="term-positive">✓</span> project Git service <span class="term-muted">9 tests</span></div><div class="terminal-line"><span class="term-positive">✓</span> terminal session recovery <span class="term-muted">12 tests</span></div><div class="terminal-line"><span class="term-positive">✓</span> project notes and files <span class="term-muted">18 tests</span></div><div class="terminal-line"><span class="term-positive">✓</span> workspace navigation <span class="term-muted">26 tests</span></div><div class="terminal-gap"></div><div class="terminal-line"><span class="term-accent">◌</span> Running remaining suites…</div><div class="terminal-line indent"><span class="term-muted">43 / 48 suites</span> <span class="progress-track"><span></span></span></div>` },
  { id: 'draft', name: 'Paper draft', kind: 'Codex', state: 'blocked', glyph: '✳', heading: 'Paper draft needs a decision', summary: 'The agent is waiting for your input.', output: `<div class="terminal-line prompt-line"><span class="terminal-prompt">›</span><span>Revise the methods paragraph using the latest results.</span></div><div class="terminal-gap"></div><div class="terminal-line"><span class="terminal-bullet blocked"></span><strong>Needs input</strong></div><div class="terminal-line indent">I found two result sets with different sample counts.</div><div class="terminal-line indent">Should I use the cleaned cohort <span class="term-accent">(n = 412)</span> or the</div><div class="terminal-line indent">full cohort <span class="term-accent">(n = 438)</span> in the paragraph?</div><div class="terminal-gap"></div><div class="terminal-line"><span class="term-muted">Waiting for your answer.</span></div>` },
  { id: 'deploy', name: 'Deploy check', kind: 'Claude', state: 'working', glyph: '✦', heading: 'Deployment review in progress', summary: 'Checking configuration and release assets.', output: `<div class="terminal-line prompt-line"><span class="terminal-prompt">›</span><span>Review the deployment configuration for the next release.</span></div><div class="terminal-gap"></div><div class="terminal-line"><span class="terminal-bullet working"></span><strong>Reviewing</strong> the packaging workflow</div><div class="terminal-line indent"><span class="term-positive">✓</span> App bundle metadata</div><div class="terminal-line indent"><span class="term-positive">✓</span> Update-feed references</div><div class="terminal-line indent"><span class="term-accent">◌</span> Checking archive contents…</div>` }
]

const projects = [
  { name: 'PanePilot', initials: 'P', color: 'indigo', state: 'ready', count: '5', active: true, path: '~/Work/PanePilot' },
  { name: 'Research paper', initials: 'R', color: 'teal', state: 'blocked', count: '7', path: '~/Papers/Research' },
  { name: 'Mobile app', initials: 'M', color: 'rose', state: 'working', count: '3', path: '~/Work/Mobile' },
  { name: 'Field notes', initials: 'F', color: 'blue', state: 'idle', count: '2', path: '~/Notes/Field' },
  { name: 'Data review', initials: 'D', color: 'amber', state: 'idle', count: '4', path: 'lab-box:~/Data' }
]

const viewItems = [
  ['terminal', 'Terminals'], ['actions', 'Actions'], ['chat', 'Project Q&A'],
  ['note', 'Notes'], ['file', 'Files'], ['chat', 'LLM Chats'], ['activity', 'Activity']
]

function projectRow(project, index) {
  return `<button class="project-row ${project.active ? 'is-active' : ''}" data-project="${index}" aria-current="${project.active ? 'page' : 'false'}"><span class="project-glyph ${project.color}">${project.initials}</span><span class="project-row-copy"><strong>${project.name}</strong><small>${index === 0 ? '5 sessions · 1 ready' : index === 1 ? '7 sessions · needs input' : index === 2 ? '3 sessions · working' : project.path}</small></span><span class="project-row-end"><span class="project-count">${project.count}</span><i class="state-dot ${project.state}"></i></span></button>`
}

function sessionButton(session) {
  return `<button class="session-tab ${session.id === 'release' ? 'is-selected' : ''}" data-session="${session.id}" role="tab" aria-selected="${session.id === 'release'}"><i class="state-dot ${session.state}"></i><span class="session-glyph">${session.glyph}</span><span class="session-tab-copy"><strong>${session.name}</strong><small>${session.kind} · ${session.state === 'ready' ? 'response ready' : session.state === 'blocked' ? 'needs input' : 'working'}</small></span>${session.id === 'release' ? icon('pin', 12) : ''}</button>`
}

function statusButton(kind, count, label) {
  return `<button class="status-item status-${kind}" data-status="${kind}" aria-expanded="false"><i class="state-dot ${kind}"></i><strong>${count}</strong><span>${label}</span></button>`
}

const concept = concepts[document.body.dataset.concept] || concepts.compass
const railStartsOpen = ['harbor', 'ledger'].includes(document.body.dataset.concept)
const root = document.getElementById('prototype')
root.innerHTML = `
  <div class="concept-app">
    <header class="app-top">
      <div class="window-side"><div class="traffic-lights" aria-hidden="true"><i></i><i></i><i></i></div><button class="sidebar-expand" aria-label="Expand sidebar" title="Expand sidebar">${icon('grid', 15)}</button><button class="app-type">${icon('terminal', 15)}<span>Terminal</span>${icon('down', 12)}</button></div>
      <div class="top-identity"><span>ACTIVE PROJECT</span><strong id="top-project">PanePilot</strong><small id="top-path">~/Work/PanePilot</small></div>
      <div class="top-tools"><button class="icon-control" title="Search commands" aria-label="Search commands">${icon('search')}</button><button class="icon-control" title="Toggle project signals" aria-label="Toggle project signals" aria-expanded="${railStartsOpen}" data-toggle-rail>${icon('git')}<i class="tool-pip"></i></button><button class="icon-control" title="Quick notes" aria-label="Quick notes">${icon('note')}</button><span class="top-rule"></span><span class="repository-badge">${icon('git', 13)} PUBLIC</span><button class="connect-button">${icon('cloud', 14)} Connect Drive</button></div>
    </header>

    <aside class="project-sidebar">
      <div class="side-brand"><span class="brand-icon">${icon('terminal', 18)}</span><span class="brand-copy"><strong>PanePilot</strong><small>Agent workspace</small></span><button class="side-collapse" aria-label="Collapse sidebar" title="Collapse sidebar">${icon('collapse', 16)}</button></div>
      <div class="side-search">${icon('search', 14)}<span>Find a project</span><kbd>⌘ K</kbd></div>
      <div class="project-scroll"><div class="connection-title"><span class="connection-icon">▣</span> THIS MAC <small>4 projects</small></div><div class="project-group">${projects.slice(0, 4).map(projectRow).join('')}</div><div class="connection-title remote-title"><span class="connection-icon">⌁</span> LAB-BOX <small>SSH · connected</small></div><div class="project-group">${projectRow(projects[4], 4)}</div><div class="sidebar-hint"><span class="hint-spot"></span><span>One response is ready in PanePilot.</span></div></div>
      <div class="side-footer"><button>${icon('grid', 15)} Archived projects <span>9</span></button><button>${icon('plus', 16)} New project</button></div>
    </aside>

    <main class="main-workspace">
      <header class="workspace-heading"><div class="workspace-heading-main"><div class="workspace-kicker"><span class="workspace-index">${icon('terminal', 12)}</span> LOCAL / TERMINAL PROJECT</div><div class="workspace-title-row"><h1 id="workspace-project">PanePilot</h1><span class="workspace-project-state"><i class="state-dot ready"></i> 1 response ready</span></div><p>5 sessions · feature/ui-refresh · local machine</p></div><div class="workspace-heading-actions"><button class="subtle-button">${icon('git', 15)} Repository</button><button class="subtle-button">${icon('plus', 15)} New terminal</button></div></header>
      <nav class="capability-nav" aria-label="Project views">${viewItems.map(([glyph, label], index) => `<button class="capability ${index === 0 ? 'is-current' : ''}" data-view="${label}" title="${label}">${icon(glyph, 15)}<span>${label}</span></button>`).join('')}</nav>
      <div class="workspace-layout">
        <section class="terminal-region" aria-label="Terminal workspace"><div class="session-strip" role="tablist" aria-label="Terminal sessions">${sessions.map(sessionButton).join('')}<button class="session-more" title="More terminals" aria-label="More terminals">${icon('more', 16)}</button></div>
          <div class="terminal-frame"><div class="focus-edge"></div><header class="terminal-top"><div class="terminal-identity"><span class="terminal-identity-icon">✳</span><span><strong id="session-heading">Release notes are ready</strong><small id="session-summary">A finished answer, waiting for your review.</small></span></div><div class="terminal-meta"><span>LOCAL · CODEX</span><button class="terminal-menu" title="Terminal options" aria-label="Terminal options">${icon('more', 17)}</button></div></header><div class="terminal-output" id="terminal-output">${sessions[0].output}</div><div class="terminal-input"><span class="input-chevron">›</span><span>Ask Codex to do anything</span><kbd>↵</kbd></div></div>
        </section>
        <aside class="context-rail" aria-label="Attention and project context"><div class="rail-head"><span>PROJECT SIGNALS</span><button class="icon-control" title="More options" aria-label="More options">${icon('more', 15)}</button></div><div class="rail-feature"><span class="rail-feature-icon">${icon('activity', 17)}</span><span class="rail-overline">NEEDS YOU</span><strong>Paper draft</strong><p>Choose which cohort to use in the methods section.</p><button data-jump-session="draft">Open question ${icon('arrow', 14)}</button></div><div class="rail-section"><div class="rail-section-title">IN PROGRESS <small>2</small></div><button data-jump-session="tests"><i class="state-dot working"></i><span><strong>Test runner</strong><small>43 of 48 suites</small></span></button><button data-jump-session="deploy"><i class="state-dot working"></i><span><strong>Deploy check</strong><small>Reviewing archive</small></span></button></div><div class="rail-section rail-git"><div class="rail-section-title">REPOSITORY</div><div class="git-row"><span>main</span><strong>3 modified</strong></div><div class="git-track"><span></span></div><small>Local branch · 2 commits ahead</small></div><div class="rail-bottom">Latest activity · 2 min ago</div></aside>
        <section class="view-placeholder" hidden><div class="view-icon">${icon('grid', 24)}</div><span class="view-eyebrow">PROJECT VIEW</span><h2 id="view-title">Actions</h2><p>This study shows how the navigation changes shape. The view content is illustrative; select Terminals to return to the terminal.</p><button data-return-terminals>Back to terminals ${icon('arrow', 15)}</button></section>
      </div>
    </main>

    <footer class="bottom-status"><div class="status-left"><span class="status-ready"><i class="state-dot online"></i> Connected</span><span class="unsafe-label">${icon('shield', 12)} UNSAFE · RELEASE NOTES</span></div><div class="status-counts">${statusButton('working', 2, 'working')}${statusButton('ready', 1, 'response ready')}${statusButton('blocked', 1, 'needs input')}<span class="status-project-total">5 projects</span></div><div class="status-popover" hidden></div></footer>
  </div>
  <div class="prototype-nav"><a href="index.html">← All concepts</a><span>${concept.number} / ${concept.name}</span><a href="${concept.previous}" aria-label="Previous concept">←</a><a href="${concept.next}" aria-label="Next concept">→</a></div>
`

function selectSession(id) {
  const session = sessions.find((item) => item.id === id)
  if (!session) return
  document.querySelectorAll('[data-session]').forEach((button) => {
    const selected = button.dataset.session === id
    button.classList.toggle('is-selected', selected)
    button.setAttribute('aria-selected', String(selected))
  })
  document.getElementById('session-heading').textContent = session.heading
  document.getElementById('session-summary').textContent = session.summary
  document.getElementById('terminal-output').innerHTML = session.output
  document.querySelector('.terminal-identity-icon').textContent = session.glyph
  document.querySelector('.terminal-frame').dataset.state = session.state
  document.querySelector('.terminal-output').scrollTop = 0
  activateView('Terminals')
}

function activateView(label) {
  document.querySelectorAll('[data-view]').forEach((button) => {
    const current = button.dataset.view === label
    button.classList.toggle('is-current', current)
    if (current) button.setAttribute('aria-current', 'page')
    else button.removeAttribute('aria-current')
  })
  const terminal = label === 'Terminals'
  document.querySelector('.terminal-region').hidden = !terminal
  document.querySelector('.view-placeholder').hidden = terminal
  document.getElementById('view-title').textContent = label
  document.querySelector('.workspace-layout').classList.toggle('view-mode', !terminal)
}

function toggleStatus(kind) {
  const popover = document.querySelector('.status-popover')
  const button = document.querySelector(`[data-status="${kind}"]`)
  const open = !popover.hidden && popover.dataset.kind === kind
  document.querySelectorAll('[data-status]').forEach((item) => item.setAttribute('aria-expanded', 'false'))
  if (open) { popover.hidden = true; return }
  const matching = sessions.filter((session) => session.state === kind)
  popover.dataset.kind = kind
  popover.innerHTML = `<div class="popover-title">${kind === 'ready' ? 'Responses ready' : kind === 'blocked' ? 'Needs input' : 'Working now'}<span>${matching.length}</span></div>${matching.map((session) => `<button data-jump-session="${session.id}"><i class="state-dot ${session.state}"></i><span><strong>${session.name}</strong><small>${session.summary}</small></span>${icon('arrow', 14)}</button>`).join('')}`
  popover.hidden = false
  button.setAttribute('aria-expanded', 'true')
}

document.addEventListener('click', (event) => {
  const target = event.target.closest('button')
  if (!target) return
  if (target.dataset.session) selectSession(target.dataset.session)
  if (target.dataset.jumpSession) { selectSession(target.dataset.jumpSession); document.querySelector('.status-popover').hidden = true }
  if (target.dataset.view) activateView(target.dataset.view)
  if (target.dataset.returnTerminals !== undefined) activateView('Terminals')
  if (target.dataset.status) toggleStatus(target.dataset.status)
  if (target.dataset.toggleRail !== undefined) {
    document.body.classList.toggle('rail-open')
    target.setAttribute('aria-expanded', String(railStartsOpen !== document.body.classList.contains('rail-open')))
  }
  if (target.classList.contains('side-collapse')) document.body.classList.toggle('sidebar-collapsed')
  if (target.classList.contains('sidebar-expand')) document.body.classList.toggle('sidebar-collapsed')
  if (target.dataset.project !== undefined) {
    const project = projects[Number(target.dataset.project)]
    document.querySelectorAll('[data-project]').forEach((row) => { row.classList.toggle('is-active', row === target); row.setAttribute('aria-current', row === target ? 'page' : 'false') })
    document.getElementById('top-project').textContent = project.name
    document.getElementById('top-path').textContent = project.path
    document.getElementById('workspace-project').textContent = project.name
  }
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') document.querySelector('.status-popover').hidden = true
})
