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
  const typeEditor = async (selector, text) => {
    // A hidden native window has no platform IME focus. Locate the live editor
    // ref through the React tree and use Monaco's ordinary edit API; production
    // model listeners, draft state, guards and persistence remain unchanged.
    await delay(150)
    await evaluate(`(() => {
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
      if(editor.getRawOptions().readOnly)throw new Error('The workflow editor is readonly.');
      editor.executeEdits('desktop-workflow-fixture',[{range:editor.getSelection(),text:${JSON.stringify(text)},forceMoveMarkers:true}]);
      editor.pushUndoStop();
    })()`)
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
    const terminal = await api(`projects.create(${JSON.stringify({ name: 'Workflow terminal', connectionId: local.id, folder: join(temp, 'projects', 'terminal'), type: 'terminal' })})`)
    const latex = await api(`projects.create(${JSON.stringify({ name: 'Workflow manuscript', connectionId: local.id, folder: join(temp, 'projects', 'manuscript'), type: 'latex', latex: { mainFile: 'main.tex', contextFolder: 'context' } })})`)
    const session = await api(`terminals.start(${JSON.stringify({ projectId: terminal.id, name: 'Workflow shell', profile: 'shell', dangerousMode: false, cols: 100, rows: 28 })})`)
    assert.equal(session.backend, 'tmux')
    const action = await api(`actions.create(${JSON.stringify({ projectId: terminal.id, name: 'Workflow action', command: "printf 'WORKFLOW_ACTION_OK\\n'" })})`)
    await evaluate(`localStorage.setItem('panepilot.latex-manuscript-layout-by-project',${JSON.stringify(JSON.stringify({ [latex.id]: { autoSave: false, mapHidden: false, commentsHidden: true } }))})`)
    await window.webContents.reload()
    await waitFor('document.querySelectorAll(".project-row").length===2', 'actual SQLite projects hydrated')
    await clickText('.session-row .sidebar-row-main', 'Workflow shell')
    await waitFor('!!document.querySelector(".xterm-rows")', 'actual xterm surface')
    await api(`terminals.write(${JSON.stringify(session.id)},${JSON.stringify("printf 'WORKFLOW_%s_OK\\n' TERMINAL\r")})`)
    await waitFor('document.querySelector(".xterm-rows")?.textContent.includes("WORKFLOW_TERMINAL_OK")', 'real PTY output through production main/preload into xterm')
    steps.push('Real isolated tmux shell and PTY output rendered through production IPC.')
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
    await typeEditor('.latex-project-workspace .monaco-editor', '% UNSAVED_LATEX_DRAFT\n')
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("UNSAVED_LATEX_DRAFT")', 'LaTeX draft typed')
    await clickText('.workspace-tabs button', 'PDF Preview')
    await waitFor('Array.from(document.querySelectorAll("[data-pdf-page] canvas")).some(c=>c.width>100&&c.height>100)', 'real PDF source read and PDF.js worker render')
    await waitFor('document.querySelector("[data-pdf-page]")?.getAttribute("aria-busy")==="false"', 'PDF rendered')
    const pixelCounts = await evaluate(`(() => { const c=document.querySelector('[data-pdf-page] canvas');const p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let dark=0,light=0;for(let i=0;i<p.length;i+=4){if(p[i]<8&&p[i+1]<8&&p[i+2]<8)dark++;if(p[i]>247&&p[i+1]>247&&p[i+2]>247)light++;}return{dark,light};})()`)
    assert.ok(pixelCounts.dark > 1000 && pixelCounts.light > 1000)
    await clickText('.workspace-tabs button', 'Manuscript')
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("UNSAVED_LATEX_DRAFT")', 'LaTeX draft survives PDF capability switch')
    await clickText('.project-row .sidebar-row-main', 'Workflow terminal')
    await clickText('.workspace-tabs button', 'Files')
    await waitFor('document.querySelector(".file-editor-shell .view-lines")?.textContent.includes("UNSAVED_FILES_DRAFT")', 'Files draft survives project switch')
    await clickText('.project-row .sidebar-row-main', 'Workflow manuscript')
    await waitFor('document.querySelector(".latex-project-workspace .view-lines")?.textContent.includes("UNSAVED_LATEX_DRAFT")', 'LaTeX draft survives project switch')
    assert.equal((await readFile(join(temp, 'projects/terminal/draft.txt'), 'utf8')).includes('UNSAVED_FILES_DRAFT'), false)
    assert.equal((await readFile(join(temp, 'projects/manuscript/main.tex'), 'utf8')).includes('UNSAVED_LATEX_DRAFT'), false)
    steps.push('Real Monaco Files and LaTeX drafts survive capability/project switches without writing the unsaved text to disk.')
    steps.push('Actual PDF IPC, PDF.js worker, and canvas render complete for a synthetic PDF.')
    await api(`terminals.stop(${JSON.stringify(session.id)})`)
    isolation.assertClean()
    assert.deepEqual(blockedRequests, [], 'No renderer network attempts.')
    assert.deepEqual(failedRequests, [], 'No failed asset loads.')
    assert.deepEqual(errors, [], 'No renderer errors.')
    await writeFile(join(temp, 'result.json'), JSON.stringify({ capturedAt: new Date().toISOString(), passed: true, electron: process.versions.electron,
      method: 'Actual out/main/index.js, production preload and built renderer in installed Electron. Temporary SQLite/profile/projects, patched test-only OS adapters, private tmux socket with empty config, fake SSH executable. No synthetic projectConsole bridge or replaced application modules.',
      steps, realIpcInvocations: ipcCalls, ipcCounts, childProcesses: isolation.calls, pdfPixels: pixelCounts, warnings, errors, blockedRequests, failedRequests,
      limits: ['Development-runtime launch, not the installed/signed application; updater remains disabled.', 'SSH is a deterministic synthetic executable, so real SSH authentication, latency, disconnections, and remote shells are not validated.', 'No agent/provider launch, external service, user archive, compile toolchain, OS permission prompt, or native printing is exercised.', 'Monaco draft input uses its edit API through a test-only React ref lookup; native keyboard/IME behavior is not exercised.', 'Functional smoke checks are not timing or power measurements.'] }, null, 2))
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
