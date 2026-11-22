// Runs the actual built main/preload/renderer with disposable state and explicit
// test-only OS adapters. No production source is replaced or bundled differently.
// Usage: node scripts/test-desktop-workflows.mjs [report.json]
// Build first. Never point this at the installed application or live app profile.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const request = createRequire(join(root, 'package.json'))
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`

if (!process.versions.electron) {
  const output = resolve(process.argv[2] ?? '/tmp/panepilot-desktop-workflows.json')
  for (const path of ['out/main/index.js', 'out/preload/index.mjs', 'out/renderer/index.html']) await access(join(root, path))
  const tmux = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((path) => spawnSync('/bin/test', ['-x', path]).status === 0)
  assert.ok(tmux, 'This workflow fixture requires tmux. It never uses the default tmux server.')
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'panepilot-desktop-workflows-')))
  const fixture = {
    temp, bin: join(temp, 'bin'), socket: join(temp, 'tmux.sock'),
    terminalFolder: join(temp, 'projects', 'terminal'), latexFolder: join(temp, 'projects', 'manuscript')
  }
  const revision = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  let exitCode = 1
  try {
    await prepare(fixture, tmux)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    exitCode = await new Promise((done, reject) => {
      const child = spawn(request('electron'), [script, '--fixture-child', temp], { env, stdio: 'inherit' })
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Desktop workflows exceeded 120 seconds.')) }, 120_000)
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code) => { clearTimeout(timeout); done(code ?? 1) })
    })
    const result = JSON.parse(await readFile(join(temp, 'result.json'), 'utf8'))
    if (process.env.PANEPILOT_MARKDOWN_SCREENSHOT) await writeFile(process.env.PANEPILOT_MARKDOWN_SCREENSHOT, await readFile(join(temp, 'markdown-viewer.png')))
    if (process.env.PANEPILOT_POWER_SAVING_SCREENSHOT) await writeFile(process.env.PANEPILOT_POWER_SAVING_SCREENSHOT, await readFile(join(temp, 'power-saving.png')))
    result.sourceRevision = revision
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(result, null, 2) + '\n')
    console.log(`Desktop workflow ${result.passed ? 'passed' : 'failed'}: ${output}`)
  } finally {
    // The exact private socket is always specified, including failure cleanup.
    spawnSync(tmux, ['-S', fixture.socket, '-f', '/dev/null', 'kill-server'], { stdio: 'ignore', timeout: 5000 })
    await rm(temp, { recursive: true, force: true })
  }
  process.exitCode = exitCode
} else {
  // Electron emits ready after the entry ESM has finished evaluation. Waiting
  // for a window at module scope would prevent production whenReady from firing.
  void runFixture().catch((error) => {
    console.error(error)
    request('electron').app.exit(1)
  })
}

async function runFixture() {
  assert.equal(process.argv[2], '--fixture-child')
  const temp = await realpath(process.argv[3])
  assert.match(temp, /panepilot-desktop-workflows-/)
  const electron = request('electron')
  const { app } = electron
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  const isolation = request('./scripts/fixtures/desktop-workflow-isolation.cjs').install({ root, temp, electron })
  const errors = [], warnings = [], blockedRequests = [], failedRequests = [], steps = []
  let window
  let ipcCalls = 0
  const ipcCounts = {}
  // Count the real IPC handlers, preserving sender checks and production behavior.
  const originalHandle = electron.ipcMain.handle.bind(electron.ipcMain)
  electron.ipcMain.handle = (channel, handler) => originalHandle(channel, (...args) => { ipcCalls++; ipcCounts[channel] = (ipcCounts[channel] ?? 0) + 1; return handler(...args) })
  app.on('browser-window-created', (_event, created) => {
    assert.equal(window, undefined, 'Fixture expects exactly one production window.')
    window = created
    window.hide()
    window.webContents.setBackgroundThrottling(false)
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') errors.push(event.message)
      if (event.level === 'warning') warnings.push(event.message)
    })
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = ['file:', 'blob:', 'data:', 'about:'].includes(new URL(details.url).protocol)
      if (!allowed) blockedRequests.push(details.url)
      callback({ cancel: !allowed })
    })
    window.webContents.session.webRequest.onErrorOccurred((details) => failedRequests.push({ url: details.url.replaceAll(root, '<checkout>').replaceAll(temp, '<fixture>'), error: details.error }))
  })
  const evaluate = (code) => window.webContents.executeJavaScript(code, true)
  const waitFor = async (condition, label = condition) => {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (await evaluate(condition)) return
      await delay(40)
    }
    throw new Error(`Workflow condition failed: ${label}`)
  }
  const clickText = async (selector, label) => {
    const expression = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e=>e.textContent.trim()===${JSON.stringify(label)})`
    await waitFor(`!!(${expression}) && !(${expression}).disabled`, `find enabled ${selector}: ${label}`)
    await evaluate(`${expression}.click()`)
  }
  const api = (expression) => evaluate(`window.projectConsole.${expression}`)
  const withEditor = async (selector, code) => {
    // A hidden native window has no platform IME focus. Locate the live editor
    // ref through the React tree and use Monaco's ordinary edit API; production
    // model listeners, draft state, guards and persistence remain unchanged.
    return evaluate(`(() => {
      const container=document.querySelector(${JSON.stringify(selector)});
      let host=container;let fiber;
      while(host&&!fiber){const key=Object.keys(host).find(key=>key.startsWith('__reactFiber'));if(key)fiber=host[key];else host=host.parentElement;}
      const pending=[fiber],seen=new Set();let editor;
      while(pending.length&&!editor){
        const current=pending.pop();if(!current||seen.has(current))continue;seen.add(current);
        for(let hook=current.memoizedState;hook&&typeof hook==='object';hook=hook.next){
          const value=hook.memoizedState?.current;
          if(value&&typeof value.executeEdits==='function'&&typeof value.getDomNode==='function'&&container.contains(value.getDomNode())){editor=value;break;}
        }
        if(current.child)pending.push(current.child);if(current.sibling)pending.push(current.sibling);if(current.return)pending.push(current.return);
      }
      if(!editor)throw new Error('The mounted Monaco editor ref is unavailable.');
      ${code}
    })()`)
  }
  const typeEditor = async (selector, text) => {
    await delay(150)
    let writable = false
    for (let attempt = 0; attempt < 100; attempt++) {
      writable = await withEditor(selector, 'return !editor.getRawOptions().readOnly')
      if (writable) break
      await delay(20)
    }
    assert.ok(writable, 'The mounted workflow editor becomes writable.')
    await withEditor(selector, `
      if(editor.getRawOptions().readOnly)throw new Error('The workflow editor is readonly.');
      editor.executeEdits('desktop-workflow-fixture',[{range:editor.getSelection(),text:${JSON.stringify(text)},forceMoveMarkers:true}]);
      editor.pushUndoStop();
    `)
  }

  try {
    await import(pathToFileURL(join(root, 'out/main/index.js')).href)
    for (let attempt = 0; !window && attempt < 200; attempt++) await delay(25)
    assert.ok(window, 'Production main created its BrowserWindow.')
    await waitFor('!!window.projectConsole && !!document.querySelector("#root")', 'actual preload bridge')
    assert.equal((await api('updates.get()')).phase, 'disabled', 'Updater is disabled in this development-runtime fixture.')
    const connections = await api('connections.list()')
    const local = connections.find((item) => item.kind === 'local')
    const remote = connections.find((item) => item.sshAlias === 'fixture-ssh')
    assert.ok(local && remote, 'Only synthetic SSH config is imported.')
    assert.equal(connections.length, 2)
    // Power saving UI uses the real bridge and isolated database. Toggle it
    // back off before any fixture sessions exist; never prune user backends.
    await waitFor('!!document.querySelector(".power-saving-toggle")', 'Power saving footer control')
    assert.deepEqual((await api('powerSaving.get()')).settings, { enabled: false, idleMinutes: 30, keepAtLeast: 3 })
    assert.equal(await evaluate('document.querySelector(".status-right").lastElementChild.classList.contains("power-saving-toggle")'), true)
    assert.ok(await evaluate('window.innerWidth - document.querySelector(".power-saving-toggle").getBoundingClientRect().right < 12'), 'Power button stays at the far right even without a YOLO pill.')
    const footerHeight = await evaluate('document.querySelector(".status-bar").getBoundingClientRect().height')
    await evaluate('document.querySelector(".power-saving-toggle").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))')
    await waitFor('!!document.querySelector(".power-saving-popover")', 'Right-click opens settings')
    await waitFor('document.querySelectorAll(".power-saving-memory small").length > 0', 'Real Electron memory breakdown renders')
    const memory = await api('powerSaving.memory()')
    assert.ok(memory.totalBytes > 0 && memory.processes.length > 0)
    assert.equal(memory.totalBytes, memory.processes.reduce((total, process) => total + process.bytes, 0))
    assert.deepEqual([memory.tmux.bytes, memory.agents.bytes], [0, 0], 'Empty private tmux socket reports known zero, not failure.')
    assert.deepEqual(await evaluate('[...document.querySelectorAll(".power-memory-group summary > span")].map(e=>e.firstChild.textContent)'), ['Electron', 'tmux', 'Agents'])
    if (process.env.PANEPILOT_POWER_SAVING_SCREENSHOT) {
      await delay(250)
      await writeFile(join(temp, 'power-saving.png'), (await window.webContents.capturePage()).toPNG())
    }
    assert.equal((await api('powerSaving.get()')).settings.enabled, false, 'Context menu must not enable cleanup.')
    for (const [label, value] of [['Idle timeout in minutes', '12'], ['Minimum open chats', '2']]) {
      await evaluate(`(() => {const input=document.querySelector('input[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    }
    await clickText('.power-saving-apply', 'Save settings')
    await waitFor('!document.querySelector(".power-saving-popover")', 'Save closes settings')
    assert.deepEqual((await api('powerSaving.get()')).settings, { enabled: false, idleMinutes: 12, keepAtLeast: 2 })
    await evaluate('document.querySelector(".power-saving-toggle").dispatchEvent(new PointerEvent("pointerdown",{button:0,clientX:10,clientY:10,bubbles:true}))')
    await waitFor('!!document.querySelector(".power-saving-popover")', 'Long press opens settings')
    await evaluate('document.querySelector(".power-saving-toggle").dispatchEvent(new PointerEvent("pointerup",{button:0,bubbles:true}));document.querySelector(".power-saving-toggle").click()')
    assert.equal((await api('powerSaving.get()')).settings.enabled, false, 'Long-press release must not toggle cleanup.')
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
    await waitFor('!document.querySelector(".power-saving-popover")', 'Power saving Escape dismissal')
    await evaluate('document.querySelector(".power-saving-toggle").click()')
    await waitFor('document.querySelector(".power-saving-toggle").getAttribute("aria-pressed")==="true"', 'Click enables filled state')
    assert.equal(await evaluate('document.querySelector(".power-saving-toggle svg").getAttribute("fill")'), 'currentColor')
    await evaluate('document.querySelector(".power-saving-toggle").click()')
    await waitFor('document.querySelector(".power-saving-toggle").getAttribute("aria-pressed")==="false"', 'Second click restores outline state')
    assert.equal(await evaluate('document.querySelector(".status-bar").getBoundingClientRect().height'), footerHeight)
    steps.push('Power saving: rightmost outline/fill toggle, right-click and hold settings, persisted idle/floor, Electron memory and Escape; no live cleanup')
    // Real main/preload + renderer Markdown reader, with only synthetic clipboard
    // data and an explicitly stubbed native picker pointing inside this fixture.
    await waitFor(`!!document.querySelector('button[aria-label="Open Markdown viewer"]')`, 'Markdown toolbar action')
    electron.clipboard.writeText('# Clipboard reader\n\n**Readable Markdown**\n\n<script>window.markdownExecuted=true</script>')
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",metaKey:true,bubbles:true,cancelable:true}))')
    await waitFor('!!document.querySelector(".command-palette input")', 'Command-K Markdown entry')
    await evaluate(`(() => {const input=document.querySelector('.command-palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'markdown clipboard');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await clickText('.command-copy strong', 'Open Markdown from clipboard')
    await waitFor('document.querySelector(".markdown-viewer-modal .markdown-body h1")?.textContent.includes("Clipboard reader")', 'Clipboard Markdown renders')
    assert.equal(await evaluate('!!window.markdownExecuted || !!document.querySelector(".markdown-viewer-modal article script")'), false)
    assert.equal((await api('markdownViewer.list()')).length, 1)
    const realDialog = electron.dialog.showOpenDialog
    electron.dialog.showOpenDialog = async (_owner, options) => {
      assert.equal(options.title, 'Open Markdown')
      return { canceled: false, filePaths: [join(temp, 'standalone.md')] }
    }
    try {
      await clickText('.markdown-viewer-heading button', 'Open file')
      await waitFor('document.querySelector(".markdown-viewer-modal .markdown-body")?.textContent.includes("STANDALONE_MARKDOWN_OK")', 'Selected file snapshot renders')
    } finally { electron.dialog.showOpenDialog = realDialog }
    await delay(200) // Wait for the opening transform before measuring the grip.
    const readerSize = () => evaluate(`(() => { const r=document.querySelector('.markdown-viewer-modal').getBoundingClientRect(); return {width:r.width,height:r.height}; })()`)
    const beforeResize = await readerSize()
    const grip = await evaluate(`(() => { const r=document.querySelector('.markdown-viewer-resize').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`)
    const pointer = (type, x, y) => window.webContents.sendInputEvent({ type, x: Math.round(x * window.webContents.getZoomFactor()), y: Math.round(y * window.webContents.getZoomFactor()), button: 'left', clickCount: 1 })
    pointer('mouseMove', grip.x, grip.y)
    pointer('mouseDown', grip.x, grip.y)
    await waitFor('document.querySelector(".markdown-viewer-modal").classList.contains("is-resizing")', 'Markdown pointer capture starts')
    pointer('mouseMove', grip.x - 60, grip.y - 40)
    await waitFor(`document.querySelector('.markdown-viewer-modal').getBoundingClientRect().width < ${beforeResize.width - 100}`, 'Drag resizes the reading area')
    pointer('mouseUp', grip.x - 60, grip.y - 40)
    await waitFor('!document.querySelector(".markdown-viewer-modal").classList.contains("is-resizing")', 'Markdown pointer capture ends')
    const afterDrag = await readerSize()
    assert.ok(Math.abs(afterDrag.width - (beforeResize.width - 120)) < 3)
    assert.ok(Math.abs(afterDrag.height - (beforeResize.height - 80)) < 3)
    await evaluate(`document.querySelector('.markdown-viewer-resize').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}))`)
    await waitFor(`document.querySelector('.markdown-viewer-modal').getBoundingClientRect().width > ${afterDrag.width + 9}`, 'Keyboard resizes the reader')
    const savedReaderSize = await readerSize()
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
    await waitFor('!document.querySelector(".markdown-viewer-modal")', 'Markdown Escape dismissal')
    await window.webContents.reload()
    await waitFor(`!!document.querySelector('button[aria-label="Open Markdown viewer"]')`, 'Markdown toolbar after renderer restart')
    assert.deepEqual((await api('powerSaving.get()')).settings, { enabled: false, idleMinutes: 12, keepAtLeast: 2 }, 'Power saving settings survive renderer restart')
    await evaluate(`document.querySelector('button[aria-label="Open Markdown viewer"]').click()`)
    await waitFor('document.querySelector(".markdown-viewer-modal .markdown-body")?.textContent.includes("STANDALONE_MARKDOWN_OK")', 'Markdown history survives renderer restart')
    await delay(200)
    assert.deepEqual(await readerSize(), savedReaderSize, 'Markdown size survives renderer restart')
    await evaluate(`document.querySelector('.markdown-viewer-resize').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    await waitFor(`document.querySelector('.markdown-viewer-modal').getBoundingClientRect().width > ${savedReaderSize.width + 50}`, 'Double-click restores default reader size')
    assert.equal((await api('markdownViewer.list()')).length, 2)
    assert.ok((await api('markdownViewer.list()')).every((entry) => !('content' in entry)))
    await clickText('.markdown-viewer-history nav strong', 'Clipboard reader')
    await waitFor('document.querySelector(".markdown-viewer-modal .markdown-body h1")?.textContent.includes("Clipboard reader")', 'History selection reads exact clipboard snapshot')
    await evaluate(`(() => {const input=document.querySelector('.markdown-history-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'standalone');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await waitFor('document.querySelectorAll(".markdown-viewer-history nav button").length===1', 'History filtering')
    await clickText('.markdown-viewer-history nav strong', 'standalone.md')
    await waitFor('document.querySelector(".markdown-viewer-modal .markdown-body")?.textContent.includes("STANDALONE_MARKDOWN_OK")', 'Filtered file selection')
    await evaluate(`(() => {const input=document.querySelector('.markdown-history-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    if (process.env.PANEPILOT_MARKDOWN_SCREENSHOT) {
      await delay(200)
      await writeFile(join(temp, 'markdown-viewer.png'), (await window.webContents.capturePage()).toPNG())
    }
    await evaluate(`document.querySelector('button[aria-label="Remove preview from history"]').click()`)
    await waitFor('document.querySelectorAll(".markdown-viewer-history nav button").length===1 && document.querySelector(".markdown-viewer-modal .markdown-body h1")?.textContent.includes("Clipboard reader")', 'Remove only the selected snapshot')
    assert.ok((await readFile(join(temp, 'standalone.md'), 'utf8')).includes('STANDALONE_MARKDOWN_OK'), 'Removing history never removes the original file')
    await evaluate(`document.querySelector('button[aria-label="Close Markdown viewer"]').click()`)
    steps.push('Markdown toolbar and Command-K clipboard import use real SQLite/IPC; sanitized preview, explicit file selection, Escape, and retained history survive a renderer restart.')
    const terminal = await api(`projects.create(${JSON.stringify({ name: 'Workflow terminal', connectionId: local.id, folder: join(temp, 'projects', 'terminal'), type: 'terminal' })})`)
    const latex = await api(`projects.create(${JSON.stringify({ name: 'Workflow manuscript', connectionId: local.id, folder: join(temp, 'projects', 'manuscript'), type: 'latex', latex: { mainFile: 'main.tex', contextFolder: 'context' } })})`)
    const session = await api(`terminals.start(${JSON.stringify({ projectId: terminal.id, name: 'Workflow shell', profile: 'shell', dangerousMode: false, cols: 100, rows: 28 })})`)
    assert.equal(session.backend, 'tmux')
    const action = await api(`actions.create(${JSON.stringify({ projectId: terminal.id, name: 'Workflow action', command: "printf 'WORKFLOW_ACTION_OK\\n'" })})`)
    await evaluate(`localStorage.setItem('panepilot.latex-manuscript-layout-by-project',${JSON.stringify(JSON.stringify({ [latex.id]: { autoSave: false, mapHidden: false, commentsHidden: true } }))})`)
    await window.webContents.reload()
    await waitFor('document.querySelectorAll(".project-row").length===2', 'actual SQLite projects hydrated')
    // This window stays hidden to avoid touching the owner's running app. Make
    // only its test document visible to optional-read scheduling.
    await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))`)
    await clickText('.session-row .sidebar-row-main', 'Workflow shell')
    await waitFor('!!document.querySelector(".xterm-rows")', 'actual xterm surface')
    await api(`terminals.write(${JSON.stringify(session.id)},${JSON.stringify("printf 'WORKFLOW_%s_OK\\n' TERMINAL\r")})`)
    await waitFor('document.querySelector(".xterm-rows")?.textContent.includes("WORKFLOW_TERMINAL_OK")', 'real PTY output through production main/preload into xterm')
    steps.push('Real isolated tmux shell and PTY output rendered through production IPC.')
    const hostMemory = await api('powerSaving.memory()')
    assert.ok(hostMemory.tmux.bytes > 0 && hostMemory.tmux.processCount >= 2, 'Actual private tmux server and client RSS is measured.')
    assert.equal(hostMemory.tmux.warning, null)
    assert.equal(hostMemory.agents.bytes, 0, 'An ordinary shell is not misreported as an agent.')
    await evaluate('document.querySelector(".power-saving-toggle").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true}))')
    await waitFor('document.querySelectorAll(".power-memory-group").length===3', 'Memory groups render')
    await evaluate('document.querySelectorAll(".power-memory-group summary")[1].click()')
    await waitFor('document.querySelectorAll(".power-memory-group")[1].textContent.includes("Shared tmux server")', 'Expandable tmux process breakdown')
    assert.ok(await evaluate('document.querySelectorAll(".power-memory-group")[1].open'))
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
    await waitFor('!document.querySelector(".power-saving-popover")', 'Close memory popup')
    const memoryReadsAfterClose = ipcCounts['power-saving:memory']
    const memoryClosedAt = Date.now()
    steps.push('Actual local tmux server/client RSS through bounded numeric-only ps; separate Electron/tmux/Agents groups, expandable details, no shell misclassification.')
    await clickText('.workspace-tabs button', 'Actions')
    await clickText('.action-runner-heading button', 'Run')
    await waitFor('document.querySelector(".action-terminal .xterm-rows")?.textContent.includes("WORKFLOW_ACTION_OK")', 'Action output rendered')
    let finalActionSession
    for (let attempt = 0; attempt < 160; attempt++) {
      const project = await api(`projects.get(${JSON.stringify(terminal.id)})`)
      const completed = project.actions.find((item) => item.id === action.id)
      finalActionSession = project.sessions.find((item) => item.id === completed?.lastSessionId)
      if (finalActionSession?.state === 'completed') break
      await delay(50)
    }
    const finalActions = await api(`actions.sync(${JSON.stringify(terminal.id)})`)
    const completedAction = finalActions.find((item) => item.id === action.id)
    assert.ok(completedAction, 'Action persists after completion.')
    assert.equal(finalActionSession?.state, 'completed', 'Action exit is detected by the real completion scheduler.')
    steps.push('Real isolated Action launches, renders command output, and reaches completed state.')
    const listing = await api(`remoteFolders.list(${JSON.stringify(remote.id)},'/fixture/remote')`)
    assert.equal(listing.currentPath, '/fixture/remote')
    assert.equal(listing.entries[0].name, 'child')
    assert.equal((await api(`connections.test(${JSON.stringify(remote.id)})`)).ok, true)
    steps.push('Production asynchronous SSH folder and connection IPC use a rejecting synthetic SSH executable.')
    await clickText('.workspace-tabs button', 'LLM Chats')
    await waitFor('document.querySelector(".chat-messages")?.textContent.includes("WORKFLOW_ARCHIVE_OK")', 'actual archive worker reads only synthetic JSONL')
    const detailReads = ipcCounts['conversations:get']
    const listReads = ipcCounts['conversations:list']
    await evaluate(`(() => { const input=document.querySelector('.chat-search input'); const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'WORKFLOW_ARCHIVE_OK');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    for (let attempt = 0; attempt < 100 && (ipcCounts['conversations:list'] ?? 0) <= listReads; attempt++) await delay(25)
    assert.ok(ipcCounts['conversations:list'] > listReads, 'Search invokes actual archive worker full-text query.')
    await delay(150)
    assert.equal(ipcCounts['conversations:get'], detailReads, 'Query highlighting does not reload the selected transcript.')
    const refreshSelector = 'button[aria-label="Refresh chat archives"]'
    await waitFor(`!document.querySelector(${JSON.stringify(refreshSelector)}).disabled`, 'archive search settled')
    await evaluate(`document.querySelector(${JSON.stringify(refreshSelector)}).click()`)
    for (let attempt = 0; attempt < 100 && ipcCounts['conversations:get'] === detailReads; attempt++) await delay(25)
    assert.ok(ipcCounts['conversations:get'] > detailReads, 'Explicit Refresh reloads transcript details.')
    steps.push('Actual archive worker, full-text search and transcript rendering use synthetic roots; query typing avoids redundant detail IPC while Refresh reloads it.')
    await clickText('.workspace-tabs button', 'Files')
    await clickText('.file-row span', 'README.md')
    await waitFor('document.querySelector(".markdown-body")?.textContent.includes("WORKFLOW_MARKDOWN_OK")', 'real local Markdown preview')
    await waitFor('Array.from(document.querySelectorAll(".markdown-body img")).some(image=>image.complete && image.naturalWidth>0)', 'real local image preview IPC')
    steps.push('Files reads real fixture Markdown and its local image through production file IPC.')
    await clickText('.file-row span', 'draft.txt')
    await clickText('.preview-header button', 'Edit')
    await waitFor('!!document.querySelector(".file-editor-shell .monaco-editor textarea")', 'real Files Monaco editor')
    await typeEditor('.file-editor-shell .monaco-editor', 'UNSAVED_FILES_DRAFT ')
    await waitFor('document.querySelector(".file-editor-shell .view-lines")?.textContent.includes("UNSAVED_FILES_DRAFT")', 'Files draft typed')
    await clickText('.project-row .sidebar-row-main', 'Workflow manuscript')
    await waitFor('!!document.querySelector(".latex-project-workspace .monaco-editor textarea")', 'real LaTeX source from main-process scan')
    assert.equal(await evaluate('!!document.querySelector(".latex-autosave-toggle")'), false, 'Autosave is unconditional; no option is exposed.')
    const manuscriptPath = join(temp, 'projects/manuscript/main.tex')
    const originalSource = await readFile(manuscriptPath, 'utf8')
    await withEditor('.latex-project-workspace .monaco-editor', 'editor.setPosition({lineNumber:4,column:3});window.fixtureSourceNode=editor.getDomNode();')
    await writeFile(manuscriptPath, '% BACKEND_SOURCE_UPDATED\n' + originalSource)
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("BACKEND_SOURCE_UPDATED")', 'external source refreshes the real Monaco model without a manual reload')
    assert.deepEqual(await withEditor('.latex-project-workspace .monaco-editor', 'return editor.getPosition()'), { lineNumber: 4, column: 3 }, 'Background refresh preserves the cursor.')
    assert.ok(await withEditor('.latex-project-workspace .monaco-editor', 'return editor.getDomNode()===window.fixtureSourceNode'), 'Background refresh retains the same editor instance.')
    await withEditor('.latex-project-workspace .monaco-editor', 'editor.setPosition({lineNumber:1,column:1});')
    steps.push('External source changes appear automatically in the actual LaTeX editor through the guarded source IPC.')
    await typeEditor('.latex-project-workspace .monaco-editor', '% UNSAVED_LATEX_DRAFT\n')
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("UNSAVED_LATEX_DRAFT")', 'LaTeX draft typed')
    for (let attempt = 0; attempt < 200 && !(await readFile(manuscriptPath, 'utf8')).includes('UNSAVED_LATEX_DRAFT'); attempt++) await delay(40)
    assert.ok((await readFile(manuscriptPath, 'utf8')).includes('UNSAVED_LATEX_DRAFT'), 'Legacy autosave:false does not disable source persistence.')
    const savedSource = await readFile(manuscriptPath, 'utf8')
    await typeEditor('.latex-project-workspace .monaco-editor', '% LOCAL_CONFLICT_DRAFT\n')
    await writeFile(manuscriptPath, '% EXTERNAL_CONFLICT_VERSION\n' + savedSource)
    await waitFor('!!document.querySelector(".latex-source-conflict")', 'overlapping backend edit stops autosave with a conflict')
    assert.ok(await evaluate('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("LOCAL_CONFLICT_DRAFT")'), 'Conflict preserves the live editor draft.')
    assert.ok((await readFile(manuscriptPath, 'utf8')).includes('EXTERNAL_CONFLICT_VERSION'), 'Conflict preserves the external disk version.')
    assert.equal((await readFile(manuscriptPath, 'utf8')).includes('LOCAL_CONFLICT_DRAFT'), false)
    await evaluate('void(window.confirm=()=>true)')
    await clickText('.latex-source-conflict button', 'Keep my version')
    await waitFor('!document.querySelector(".latex-source-conflict")', 'explicit conflict resolution settles')
    assert.ok((await readFile(manuscriptPath, 'utf8')).includes('LOCAL_CONFLICT_DRAFT'))
    const resolvedSource = await readFile(manuscriptPath, 'utf8')
    await typeEditor('.latex-project-workspace .monaco-editor', '% DISCARD_LOCAL_VERSION\n')
    await writeFile(manuscriptPath, '% LOAD_DISK_VERSION\n' + resolvedSource)
    await waitFor('!!document.querySelector(".latex-source-conflict")', 'second overlapping change is detected independently')
    await clickText('.latex-source-conflict button', 'Load disk version')
    await waitFor('!document.querySelector(".latex-source-conflict") && document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("LOAD_DISK_VERSION")', 'explicit disk version loads into the editor')
    assert.equal(await evaluate('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("DISCARD_LOCAL_VERSION")'), false)
    steps.push('Always-on autosave ignores a legacy off preference; overlapping external edits preserve both versions until explicit guarded resolution.')
    await clickText('.workspace-tabs button', 'PDF Preview')
    await waitFor('Array.from(document.querySelectorAll("[data-pdf-page] canvas")).some(c=>c.width>100&&c.height>100)', 'real PDF source read and PDF.js worker render')
    await waitFor('document.querySelector("[data-pdf-page]")?.getAttribute("aria-busy")==="false"', 'PDF rendered')
    const pixelCounts = await evaluate(`(() => { const c=document.querySelector('[data-pdf-page] canvas');const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let dark=0,light=0;for(let i=0;i<p.length;i+=4){if(p[i]<8&&p[i+1]<8&&p[i+2]<8)dark++;if(p[i]>247&&p[i+1]>247&&p[i+2]>247)light++;}return{dark,light};})()`)
    assert.ok(pixelCounts.dark > 1000 && pixelCounts.light > 1000)
    await delay(100)
    const hiddenSourceReads = ipcCounts['latex:read-source']
    const pdfReads = ipcCounts['latex:get-pdf-snapshot']
    await writeFile(manuscriptPath, '% WHILE_MANUSCRIPT_HIDDEN\n' + await readFile(manuscriptPath, 'utf8'))
    await delay(2300)
    assert.equal(ipcCounts['latex:read-source'], hiddenSourceReads, 'The hidden Manuscript does not poll while PDF Preview is active.')
    assert.equal(ipcCounts['latex:get-pdf-snapshot'], pdfReads, 'Source sync does not replace or recompile the PDF.')
    await clickText('.workspace-tabs button', 'Manuscript')
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("WHILE_MANUSCRIPT_HIDDEN")', 'returning to Manuscript promptly refreshes the external source')
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("UNSAVED_LATEX_DRAFT")', 'LaTeX draft survives PDF capability switch')
    await clickText('.project-row .sidebar-row-main', 'Workflow terminal')
    await clickText('.workspace-tabs button', 'Files')
    await waitFor('document.querySelector(".file-editor-shell .view-lines")?.textContent.includes("UNSAVED_FILES_DRAFT")', 'Files draft survives project switch')
    await clickText('.project-row .sidebar-row-main', 'Workflow manuscript')
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("UNSAVED_LATEX_DRAFT")', 'LaTeX draft survives project switch')
    assert.equal((await readFile(join(temp, 'projects/terminal/draft.txt'), 'utf8')).includes('UNSAVED_FILES_DRAFT'), false)
    assert.equal((await readFile(manuscriptPath, 'utf8')).includes('UNSAVED_LATEX_DRAFT'), true)
    steps.push('Real Monaco drafts survive capability/project switches; Files remains unsaved while LaTeX is automatically persisted.')
    await withEditor('.latex-project-workspace .monaco-editor', 'editor.setPosition({lineNumber:1,column:1});')
    await typeEditor('.latex-project-workspace .monaco-editor', '% FLUSH_ON_PROJECT_SWITCH\n')
    await clickText('.project-row .sidebar-row-main', 'Workflow terminal')
    for (let attempt = 0; attempt < 200 && !(await readFile(manuscriptPath, 'utf8')).includes('FLUSH_ON_PROJECT_SWITCH'); attempt++) await delay(40)
    assert.ok((await readFile(manuscriptPath, 'utf8')).includes('FLUSH_ON_PROJECT_SWITCH'), 'Leaving before the debounce still flushes the pending source draft.')
    steps.push('Hidden Manuscript source polling sleeps, return refreshes immediately, and pending drafts persist when switching projects.')
    steps.push('Actual PDF IPC, PDF.js worker, and canvas render complete for a synthetic PDF.')
    await clickText('.workspace-tabs button', 'Terminals')
    await waitFor('!!document.querySelector(".terminal-tab .tab-menu-button")', 'ordinary terminal remains available before archive')
    const openWorkspaceSplit = async () => {
      await evaluate(`Array.from(document.querySelectorAll('.project-row .sidebar-row-main')).find(row=>row.textContent.trim()==='Workflow manuscript').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:120}))`)
      await clickText('.context-menu button span', 'Open in split pane')
      await waitFor('!!document.querySelector(".workspace-split-resizer") && !!document.querySelector(".workspace-pane:last-child .monaco-editor")', 'Main workspace split opens')
      await delay(350)
    }
    const closeWorkspaceSplit = async () => {
      await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",metaKey:true,bubbles:true,cancelable:true}))')
      await waitFor('!!document.querySelector(".command-palette input")', 'Split commands available')
      await evaluate(`(() => {const input=document.querySelector('.command-palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'close right split');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
      await clickText('.command-copy strong', 'Close right split pane')
      await waitFor('!document.querySelector(".workspace-split-resizer")', 'Split divider hides when closed')
      await delay(350)
    }
    const splitRatio = () => evaluate(`(() => { const root=document.querySelector('.workspace-split');return root.firstElementChild.getBoundingClientRect().width/root.getBoundingClientRect().width; })()`)
    const splitLaunches = isolation.calls.filter((call) => call.args?.includes('new-session')).length
    await openWorkspaceSplit()
    await evaluate(`window.fixtureSplitTerminal=document.querySelector('.workspace-pane:first-child .xterm');window.fixtureSplitEditor=document.querySelector('.workspace-pane:last-child .monaco-editor')`)
    const divider = await evaluate(`(() => {const r=document.querySelector('.workspace-split-resizer').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
    pointer('mouseMove', divider.x, divider.y)
    pointer('mouseDown', divider.x, divider.y)
    await waitFor('document.querySelector(".workspace-split").classList.contains("split-resizing")', 'Main divider captures pointer')
    pointer('mouseMove', divider.x + 60, divider.y)
    await waitFor('Number(document.querySelector(".workspace-split-resizer").getAttribute("aria-valuenow"))>52', 'Main panes resize while dragging')
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".workspace-pane")).transitionDuration'), '0s', 'Direct dragging has no layout animation lag')
    pointer('mouseUp', divider.x + 60, divider.y)
    await waitFor('!document.querySelector(".workspace-split").classList.contains("split-resizing")', 'Main divider releases pointer')
    const savedSplitRatio = await evaluate('Number(localStorage.getItem("panepilot.workspace-split-ratio.v1"))')
    const splitMatchesSaved = `(() => { const root=document.querySelector('.workspace-split');return Math.abs(root.firstElementChild.getBoundingClientRect().width/root.getBoundingClientRect().width - ${savedSplitRatio}) < 0.01; })()`
    await waitFor(splitMatchesSaved, 'Saved split matches the rendered pane widths')
    assert.equal(await evaluate('document.querySelector(".workspace-pane:first-child .xterm")===window.fixtureSplitTerminal && document.querySelector(".workspace-pane:last-child .monaco-editor")===window.fixtureSplitEditor'), true, 'Dragging retains live terminal and editor nodes')
    assert.equal(await evaluate('document.querySelector(".workspace-pane:last-child").classList.contains("focused")'), true, 'Divider does not change focused project')
    await evaluate('document.querySelector(".workspace-split").style.width="550px"')
    await delay(350)
    assert.ok(Math.abs(await splitRatio() - 0.5) < 0.01, 'Narrow workspace keeps both panes visible')
    await evaluate('document.querySelector(".workspace-split").style.removeProperty("width")')
    await waitFor(splitMatchesSaved, 'Widening restores preferred split')
    assert.ok(Math.abs(await splitRatio() - savedSplitRatio) < 0.01, 'Widening restores preferred proportions')
    await closeWorkspaceSplit()
    await openWorkspaceSplit()
    assert.ok(Math.abs(await splitRatio() - savedSplitRatio) < 0.01, 'Reopening retains preferred proportions')
    await evaluate(`document.querySelector('.workspace-split-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true,cancelable:true}))`)
    await delay(350)
    assert.ok(await splitRatio() < savedSplitRatio - 0.01, 'Keyboard adjusts split')
    await evaluate(`document.querySelector('.workspace-split-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`)
    await delay(350)
    assert.ok(Math.abs(await splitRatio() - 0.5) < 0.01, 'Double-click balances the panes')
    await closeWorkspaceSplit()
    assert.equal(isolation.calls.filter((call) => call.args?.includes('new-session')).length, splitLaunches, 'Split resize never restarts a terminal')
    steps.push('Main split supports captured dragging, keyboard resize, minimum widths, reset and remembered proportions; editors and terminals retain their mounted nodes without restarting backends.')
    await evaluate('document.querySelector(".terminal-tab .tab-menu-button").click()')
    await clickText('.terminal-menu-portal button', 'Archive terminal')
    await waitFor('!document.querySelector(".terminal-tab") && !!document.querySelector(".terminal-archive-shortcut:not([hidden])")', 'archived tab disappears and the uncrowded bar offers its archive')
    const archivedSession = (await api(`projects.get(${JSON.stringify(terminal.id)})`)).sessions.find((item) => item.id === session.id)
    assert.equal(archivedSession.archived, true)
    assert.equal(archivedSession.state, 'completed')
    assert.ok(isolation.calls.some((call) => call.args?.includes('kill-session') && call.args.includes('=Workflow shell')), 'Archive stops exactly the private fixture tmux target.')
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".session-row")).some(row=>row.textContent.includes("Workflow shell"))'), false, 'Archive is hidden in the sidebar.')
    const launchesBeforeRestore = isolation.calls.filter((call) => call.args?.includes('new-session')).length
    await evaluate(`Array.from(document.querySelectorAll('.project-row .sidebar-row-main')).find(row=>row.textContent.trim()==='Workflow terminal').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:80,clientY:120}))`)
    await clickText('.context-menu button span', 'Archived terminals (1)')
    await waitFor('!!document.querySelector(".terminal-archives-modal")', 'project right-click opens the correct archive')
    await evaluate(`document.querySelector('.terminal-archives-modal [aria-label="Restore Workflow shell"]').click()`)
    await waitFor('document.querySelector(".terminal-archives-empty strong")?.textContent==="No archived terminals" && !!document.querySelector(".terminal-tab")', 'Restore returns the exact terminal tab')
    assert.equal(isolation.calls.filter((call) => call.args?.includes('new-session')).length, launchesBeforeRestore, 'Restore does not implicitly start a shell or agent.')
    assert.equal((await api(`projects.get(${JSON.stringify(terminal.id)})`)).archived, false, 'Terminal archive never archives its project.')
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
    await waitFor('!document.querySelector(".terminal-archives-modal")', 'Escape dismisses only the archive dialog')
    steps.push('Actual tab-menu Archive stops only its exact tmux session; project context-menu archive and Restore retain the same tab without launching a new process.')
    const launchesBeforeReload = isolation.calls.filter((call) => call.pty && call.args?.includes('new-session')).length
    const waitForReload = async (count) => {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (isolation.calls.filter((call) => call.pty && call.args?.includes('new-session')).length === launchesBeforeReload + count) break
        await delay(25)
      }
      assert.equal(isolation.calls.filter((call) => call.pty && call.args?.includes('new-session')).length, launchesBeforeReload + count)
      const current = (await api(`projects.get(${JSON.stringify(terminal.id)})`)).sessions.filter((item) => item.kind === 'terminal')
      assert.equal(current.length, 1, 'Force reload never creates a second saved terminal tab.')
      assert.equal(current[0].id, session.id)
      assert.equal(current[0].name, 'Workflow shell')
      assert.equal(current[0].state, 'idle')
    }
    // Restore left no tmux backend. Force reload must recreate it via the real
    // preload/main path, not just try to reattach to that missing backend.
    await evaluate('document.querySelector(".terminal-tab .tab-menu-button").click()')
    await clickText('.terminal-menu-portal button', 'Force reload')
    await waitForReload(1)
    await evaluate(`Array.from(document.querySelectorAll('.session-row')).find(row=>row.textContent.includes('Workflow shell')).dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:90,clientY:160}))`)
    await clickText('.context-menu button span', 'Force reload')
    await waitForReload(2)
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"k",metaKey:true,bubbles:true,cancelable:true}))')
    await waitFor('!!document.querySelector(".command-palette input")', 'Command-K opens for the active shell')
    await evaluate(`(() => {const input=document.querySelector('.command-palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'force reload');input.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    await clickText('.command-copy strong', 'Force reload')
    await waitForReload(3)
    steps.push('Force reload in the tab menu recreates the missing shell tmux backend in the same tab; sidebar and Command-K offer the same compact label and restart that exact terminal.')
    assert.ok(Date.now() - memoryClosedAt > 5000, 'Closed-memory observation spans a refresh interval.')
    assert.equal(ipcCounts['power-saving:memory'], memoryReadsAfterClose, 'Process sampling stops when the popup closes.')
    isolation.assertClean()
    assert.deepEqual(blockedRequests, [], 'No renderer network attempts.')
    assert.deepEqual(failedRequests, [], 'No failed asset loads.')
    assert.deepEqual(errors, [], 'No renderer errors.')
    await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))`)
    await writeFile(join(temp, 'result.json'), JSON.stringify({ capturedAt: new Date().toISOString(), passed: true, electron: process.versions.electron,
      method: 'Actual out/main/index.js, production preload and built renderer in installed Electron. Temporary SQLite/profile/projects, patched test-only OS adapters, private tmux socket with empty config, fake SSH executable. No synthetic projectConsole bridge or replaced application modules.',
      steps, realIpcInvocations: ipcCalls, ipcCounts, childProcesses: isolation.calls, pdfPixels: pixelCounts, warnings, errors, blockedRequests, failedRequests,
      limits: ['Development-runtime launch, not the installed/signed application; updater remains disabled.', 'SSH is a deterministic synthetic executable, so real SSH authentication, latency, disconnections, and remote shells are not validated.', 'No agent/provider launch, external service, user archive, compile toolchain, OS permission prompt, or native printing is exercised.', 'Monaco draft input uses its edit API through a test-only React ref lookup; native keyboard/IME behavior is not exercised.', 'Functional smoke checks are not timing or power measurements.'] }, null, 2))
    // Tear down the fixture renderer before main closes its temporary database;
    // no delayed metadata refresh should send new IPC during test shutdown.
    window.destroy()
    app.quit()
  } catch (error) {
    console.error(error)
    const body = window ? await evaluate('document.body.innerText.slice(-7000)').catch(() => null) : null
    console.error(body)
    console.error(window ? await evaluate('({active:document.activeElement?.outerHTML.slice(0,500),textareas:[...document.querySelectorAll("textarea")].map(t=>({value:t.value,active:t===document.activeElement})),focus:document.hasFocus()})').catch(()=>null) : null)
    await writeFile(join(temp, 'result.json'), JSON.stringify({ passed: false, error: String(error), steps, body, errors, warnings, blockedRequests, failedRequests, violations: isolation.violations, childProcesses: isolation.calls }, null, 2)).catch(() => {})
    app.exit(1)
  }
}

async function prepare(fixture, tmux) {
  const { temp, bin, socket, terminalFolder, latexFolder } = fixture
  for (const directory of [bin, terminalFolder, latexFolder, join(latexFolder, 'context'), join(temp, 'synthetic-home/.ssh'), join(temp, 'synthetic-home/.codex/sessions'), join(temp, 'appdata/project-console'), join(temp, 'session'), join(temp, 'logs')]) await mkdir(directory, { recursive: true })
  await writeFile(join(temp, 'synthetic-home/.ssh/config'), 'Host fixture-ssh\n  HostName fixture.invalid\n')
  await writeFile(join(temp, 'standalone.md'), '# STANDALONE_MARKDOWN_OK\n\nA read-only file preview.\n\n## Release checklist\n\n- [x] Preview from clipboard\n- [x] Keep recent documents\n- [ ] Ship the next idea\n\n> [!NOTE]\n> Snapshots stay on this device.\n\n| Source | Preview |\n| --- | --- |\n| Clipboard | Markdown text |\n| File | Saved snapshot |\n\n```typescript\nconst history = previews.slice(0, 50)\n```\n')
  await writeFile(join(bin, 'tmux'), `#!/bin/sh\nexec ${quote(tmux)} -S ${quote(socket)} -f /dev/null "$@"\n`)
  const shell = '#!/bin/sh\nunset ENV BASH_ENV ZDOTDIR\ncase "$1" in\n  -lic|-lc|-c) shift; exec /bin/sh -c "$1" ;;\n  -l) exec /bin/sh ;;\n  *) exec /bin/sh "$@" ;;\nesac\n'
  await writeFile(join(bin, 'fixture-shell'), shell)
  await writeFile(join(bin, 'sh'), shell)
  await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst args=process.argv.slice(2);if(!args.includes('fixture-ssh'))process.exit(91);const command=args.at(-1);if(command==='printf panepilot-ok'){process.stdout.write('panepilot-ok');process.exit(0)}const encoded=command.match(/[A-Za-z0-9+/]{60,}={0,2}/)?.[0];if(!encoded){process.stderr.write('Fixture SSH has no tmux server');process.exit(1)}const script=Buffer.from(encoded,'base64').toString();let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>{const payload=JSON.parse(data);if(payload.path!=='/fixture/remote')process.exit(92);if(script.includes('parentPath'))process.stdout.write(JSON.stringify({currentPath:'/fixture/remote',parentPath:'/fixture',entries:[{name:'child',path:'/fixture/remote/child',kind:'directory',size:null}]}));else if(script.includes('currentPath'))process.stdout.write(JSON.stringify({currentPath:'/fixture/remote'}));else process.exit(93)});\n`)
  await writeFile(join(bin, 'rclone'), '#!/bin/sh\n[ "$1" = listremotes ] && [ "$#" = 1 ] || exit 94\n')
  for (const name of ['tmux', 'fixture-shell', 'sh', 'ssh', 'rclone']) await chmod(join(bin, name), 0o700)
  await writeFile(join(terminalFolder, 'README.md'), '# WORKFLOW_MARKDOWN_OK\n\n![Fixture pixel](pixel.svg)\n')
  await writeFile(join(terminalFolder, 'pixel.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>')
  await writeFile(join(terminalFolder, 'draft.txt'), 'Saved files source.\n')
  const records = [
    { type: 'session_meta', payload: { id: 'workflow-synthetic-thread', cwd: terminalFolder } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic archived question.' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'WORKFLOW_ARCHIVE_OK synthetic archived answer.' }] } }
  ]
  await writeFile(join(temp, 'synthetic-home/.codex/sessions/fixture.jsonl'), records.map(record => JSON.stringify({ timestamp: '2026-01-01T00:00:00.000Z', ...record })).join('\n') + '\n')
  await writeFile(join(latexFolder, 'main.tex'), '\\documentclass{article}\n\\begin{document}\n\\section{Workflow section}\nSaved manuscript source.\n\\end{document}\n')
  await writeFile(join(latexFolder, 'main.pdf'), pdf())
}

function pdf() {
  const stream = '0 0 0 rg 30 30 100 100 re f\n'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>', `<< /Length ${stream.length} >>\nstream\n${stream}endstream`]
  let data = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = Buffer.byteLength(data)
  data += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return data
}
