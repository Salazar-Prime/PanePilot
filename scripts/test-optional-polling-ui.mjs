import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real LaTeX workspace polling and session switching; document panels and IPC
// are isolated fixtures. No project folder, provider archive, or SSH is opened.
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-optional-polling-'))
  try {
    await build({
      stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'document-fixtures', setup(builder) {
        builder.onResolve({ filter: /\/(ActionsPanel|ChatHistoryPanel|FilesPanel|HistoryPanel|NotesPanel|LatexManuscript|LatexPdfPreview|LatexAgentPane|LatexChatLauncher)$/ }, ({ path }) =>
          ({ path: path.split('/').at(-1), namespace: 'fixture-panel' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture-panel' }, ({ path }) => ({
          loader: 'tsx', resolveDir: root,
          contents: path === 'LatexManuscript'
            ? `export function LatexManuscript(props){return <div id="manuscript" data-changes={JSON.stringify(props.changes)}><button id="clear" onClick={props.onClearChanges}>Clear</button></div>}`
            : `export function ${path}(){return <div/>}`
        }))
      } }]
    })
    await writeFile(join(temp, 'index.html'), '<html><body><div id="root"></div><div id="status-workspace-nav"></div><script src="fixture.js"></script></body></html>')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', done)
    })
    if (code !== 0) process.exitCode = 1
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  setTimeout(() => { process.stderr.write('Optional polling fixture timed out.\n'); app.exit(1) }, 20_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const delay = (ms = 100) => new Promise((done) => setTimeout(done, ms))
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await delay(10)
      }
      throw new Error(`Fixture did not settle: ${code}`)
    }
    const count = () => evaluate('window.calls.length')
    const changes = () => evaluate('JSON.parse(document.querySelector("#manuscript").dataset.changes)')
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor('window.calls.length===1 && document.querySelector("#manuscript")')
      await delay()
      assert.equal(await count(), 1, 'A slow diff must not overlap its next scheduled read')
      await evaluate(`window.changeFixture({selected:'chat-b'})`)
      await waitFor('window.calls.length===2')
      await evaluate(`window.resolveRead('chat-b','current');window.setHidden(true)`)
      await waitFor(`document.querySelector('#manuscript').dataset.changes.includes('current')`)
      await evaluate(`window.resolveRead('chat-a','obsolete')`)
      await delay()
      assert.equal((await changes()).capturedAt, 'current', 'The old session must not replace the selected diff')
      assert.equal(await count(), 2, 'Hidden documents do no optional diff polling')
      await evaluate(`window.setHidden(false);window.dispatchEvent(new Event('focus'))`)
      await waitFor('window.calls.length===3')
      await delay()
      assert.equal(await count(), 3, 'Foreground/focus events share one running diff')
      await evaluate(`document.querySelector('#clear').click()`)
      assert.equal(await evaluate('window.clears.length'), 0, 'Clearing waits for an existing diff snapshot')
      await evaluate(`window.resolveRead('chat-b','before-clear');window.setHidden(true)`)
      await waitFor('window.clears.length===1')
      await waitFor(`document.querySelector('#manuscript').dataset.changes.includes('"capturedAt":null')`)
      await evaluate(`window.changeFixture({active:false});window.setHidden(false)`)
      await delay()
      // The visibility event is dispatched before React commits the inactive
      // workspace. Any already-started call is held and settled below.
      const beforeInactive = await count()
      await evaluate(`window.resolveAll()`)
      await delay()
      assert.equal(await count(), beforeInactive, 'Inactive projects stop polling')
      await evaluate(`window.changeFixture({active:true})`)
      await waitFor(`window.calls.length===${beforeInactive + 1}`)
      await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Files').click();window.resolveAll()`)
      await delay()
      assert.equal(await count(), beforeInactive + 1, 'Hidden manuscript capability stops polling')
      await evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Manuscript').click()`)
      await waitFor(`window.calls.length===${beforeInactive + 2}`)
      await evaluate(`window.changeFixture({otherProject:true,selected:'chat-other'})`)
      await waitFor(`window.calls.length===${beforeInactive + 3}`)
      await evaluate(`window.resolveRead('chat-other','other-project-current');window.setHidden(true)`)
      await waitFor(`document.querySelector('#manuscript').dataset.changes.includes('other-project-current')`)
      await evaluate(`window.resolveRead('chat-b','obsolete-project')`)
      await delay()
      assert.equal((await changes()).capturedAt, 'other-project-current', 'An old project must not replace the selected project diff')
      await evaluate(`window.changeFixture({mounted:false})`)
      await waitFor(`!document.querySelector('#manuscript')`)
      await evaluate(`window.resolveAll();window.setHidden(true);window.setHidden(false);window.dispatchEvent(new Event('focus'))`)
      await delay()
      assert.equal(await count(), beforeInactive + 3, 'Unmount cancels further polling')
      assert.ok(Object.values(await evaluate('window.peaks')).every((peak) => peak === 1), 'Each session has at most one request in flight')
      assert.deepEqual(await evaluate('window.errors'), [])
      process.stdout.write('Optional polling UI passed: slow-call coalescing, exact-session stale-result rejection, hidden/inactive/capability suppression, immediate foreground refresh, clear ordering, and unmount cleanup.\n')
      window.destroy()
      app.exit(0)
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`)
      process.stderr.write(`${JSON.stringify(await evaluate('window.errors').catch(() => []))}\n`)
      window.destroy()
      app.exit(1)
    }
  })
}

function fixture() {
  return `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {LatexProjectWorkspace} from './src/renderer/src/components/LatexProjectWorkspace';
    window.errors=[];
    window.addEventListener('error',event=>window.errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.errors.push(String(event.reason)));
    let hidden=false;
    Object.defineProperty(document,'hidden',{get:()=>hidden});
    window.setHidden=value=>{hidden=value;document.dispatchEvent(new Event('visibilitychange'))};
    const nativeTimeout=window.setTimeout.bind(window);
    window.setTimeout=(callback,delay,...args)=>nativeTimeout(callback,delay===1800?20:delay,...args);
    window.calls=[];window.clears=[];window.peaks={};const pending=new Map();
    window.resolveRead=(id,mark)=>{const resolve=pending.get(id);if(resolve){pending.delete(id);resolve({sessionId:id,capturedAt:mark,files:[]})}};
    window.resolveAll=()=>{for(const id of [...pending.keys()])window.resolveRead(id,'settled')};
    window.projectConsole={latex:{
      getWorkspace:async(projectId)=>({details:{projectId,mainFile:'main.tex',contextFolder:'context'},sections:[]}),
      listComments:async()=>[],listInlineEdits:async()=>[],
      changes:id=>{window.calls.push(id);window.peaks[id]=Math.max(window.peaks[id]||0,pending.has(id)?2:1);return new Promise(resolve=>pending.set(id,resolve))},
      clearChanges:async id=>{window.clears.push(id)}
    }};
    const noop=()=>{};const asyncNoop=async()=>{};
    const session=id=>({id,projectId:'paper',kind:'latex-chat',name:id,profile:'codex',backend:'tmux',tmuxName:id,
      state:'running',archived:false,pinned:false,flagged:false,dangerousMode:false,output:'',
      latexChat:{purpose:'writing',scope:'project',mode:'edit',sectionId:null},
      providerSessionId:null,providerSessionName:null,customCommand:null,createdAt:'2026-01-01',updatedAt:'2026-01-01'});
    const project={id:'paper',type:'latex',name:'Paper',icon:null,connectionId:'local',folder:'/fixture',
      repositoryUrl:null,latex:null,state:'running',archived:false,createdAt:'2026-01-01',updatedAt:'2026-01-01',
      sessions:[session('chat-a'),session('chat-b')],actions:[],activities:[]};
    function Fixture(){
      const [state,setState]=useState({selected:'chat-a',active:true,mounted:true,otherProject:false});
      window.changeFixture=patch=>setState(current=>({...current,...patch}));
      const currentProject=state.otherProject?{...project,id:'other-paper',sessions:[{...session('chat-other'),projectId:'other-paper'}]}:project;
      return state.mounted ? <LatexProjectWorkspace project={currentProject} connection={{id:'local',kind:'local',name:'Local'}}
        workspaceActive={state.active} selectedSessionId={state.selected} launchTerminalRequest={null} openSessionRequest={null}
        workspaceTabRequest={null} terminalTransportStates={{}} openSessionIds={new Set()} onOpenSession={noop} onCloseSession={noop}
        onSessionSelected={noop} onLaunchTerminalRequestHandled={noop} onOpenSessionRequestHandled={noop} onWorkspaceTabRequestHandled={noop}
        onWorkspaceDestinationVisited={noop} onSelectSession={noop} onChanged={asyncNoop}/> : null;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `
}
