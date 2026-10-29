import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real workspace components and xterms; only unrelated file/document panels and
// IPC backends are fixtures. The hidden window never opens the user's workspace.
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-surface-cache-ui-'))
  try {
    await build({
      stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      alias: { '@shared': join(root, 'src/shared') },
      outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'unrelated-panels', setup(builder) {
        builder.onResolve({ filter: /\/(ActionsPanel|ChatHistoryPanel|FilesPanel|HistoryPanel|NotesPanel|LatexManuscript|LatexPdfPreview)$/ }, ({ path }) =>
          ({ path: path.split('/').at(-1), namespace: 'fixture-panel' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture-panel' }, ({ path }) => ({
          loader: 'tsx', resolveDir: root,
          contents: `export function ${path}(){return <div data-fixture-panel="${path}"/>}`
        }))
      } }]
    })
    const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    const xtermCss = await readFile(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${css}${xtermCss}
      #root{height:calc(100% - 40px);display:flex}#status-workspace-nav{height:40px}
      </style></head><body><div id="root"></div><div id="status-workspace-nav"></div><script src="fixture.js"></script></body></html>`)
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
  setTimeout(() => { process.stderr.write('Terminal surface test timed out.\n'); app.exit(1) }, 35_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1450, height: 850, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const settle = () => evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(done,30))))')
    const surfaces = () => evaluate(`Array.from(document.querySelectorAll('.managed-terminal'),e=>e.dataset.terminalSessionId).sort()`)
    const click = (text) => evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`)
    const probeHiddenChat = async (reason) => {
      await settle()
      const before = await evaluate('({writes:window.writes.length,resizes:window.resizes.length,prompts:window.prompts.length})')
      await evaluate(`window.probeChat();document.querySelector('.latex-composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}))`)
      await settle()
      assert.deepEqual(await evaluate('({writes:window.writes.length,resizes:window.resizes.length,prompts:window.prompts.length})'), before,
        `${reason}: hidden terminal and composer must send no input or resize IPC`)
      assert.equal(await evaluate(`window.chatNode===document.querySelector('.latex-agent-terminal .xterm')`), true,
        `${reason}: preserve the existing chat surface`)
    }
    try {
      await window.loadFile(join(temp, 'index.html'))
      const counts = []
      for (let index = 0; index < 4; index++) {
        await evaluate(`window.changeFixture({index:${index},selected:'project-${index}-second'})`)
        await waitFor(`document.querySelector('.pane-workspace-entry.active [data-terminal-session-id="project-${index}-second"] .xterm')!==null`)
        await settle()
        const ids = await surfaces()
        assert.deepEqual(ids, Array.from({ length: index + 1 }, (_, i) => `project-${i}-second`))
        assert.equal(await evaluate('window.dataListeners.size'), index + 1)
        assert.equal(await evaluate('window.transportListeners.size'), index + 1)
        assert.equal(await evaluate(`document.querySelectorAll('.xterm').length`), index + 1)
        counts.push(ids.length)
      }
      assert.deepEqual(await evaluate('window.attaches'), Array.from({ length: 4 }, (_, i) => `project-${i}-second`),
        'Inactive projects must never attach their unselected first tabs')
      await evaluate(`window.keptNode=document.querySelector('[data-terminal-session-id="project-2-second"] .xterm');window.changeFixture({index:4,selected:'project-4-second'})`)
      await waitFor(`document.querySelector('[data-terminal-session-id="project-4-second"] .xterm')!==null`)
      await settle()
      assert.deepEqual(await surfaces(), [1, 2, 3, 4].map((i) => `project-${i}-second`))
      assert.equal(await evaluate('window.dataListeners.size'), 4)
      await evaluate(`window.changeFixture({index:2,selected:'project-2-second'})`)
      await settle()
      assert.equal(await evaluate(`window.keptNode===document.querySelector('[data-terminal-session-id="project-2-second"] .xterm')`), true)
      assert.equal(await evaluate(`window.attaches.filter(id=>id==='project-2-second').length`), 1)
      assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.pane-workspace-entry.active .terminal-tab-select > span:last-child'),e=>e.textContent)`),
        ['project-2-first', 'project-2-second'], 'Surface retention must not reorder tabs')

      await evaluate(`window.changeFixture({latex:true,selected:'writing-chat'})`)
      await waitFor(`document.querySelector('.latex-agent-terminal .xterm')!==null`)
      await settle()
      assert.equal(await evaluate('window.dataListeners.size'), 1)
      await evaluate(`window.chatNode=document.querySelector('.latex-agent-terminal .xterm');const field=document.querySelector('.latex-composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Keep this unsent draft');field.dispatchEvent(new Event('input',{bubbles:true}));window.probeChat()`)
      await waitFor(`window.writes.some(entry=>entry.id==='writing-chat') && window.resizes.some(entry=>entry.id==='writing-chat')`)
      await evaluate(`document.querySelector('[aria-label="Writing chat options"]').click()`)
      await click('Hide writing chat')
      await waitFor(`document.querySelector('.latex-agent-pane')?.getAttribute('aria-hidden')==='true'`)
      await probeHiddenChat('Collapsed margin')
      await click('Chat')
      await waitFor(`document.querySelector('.latex-agent-pane')?.getAttribute('aria-hidden')==='false'`)
      for (const tab of ['Files', 'Actions', 'Notes']) {
        await click(tab)
        await waitFor(`document.querySelector('.latex-workbench').classList.contains('cached')`)
        await probeHiddenChat(`${tab} capability`)
        await click('Manuscript')
        await waitFor(`document.querySelector('.latex-agent-pane')?.getAttribute('aria-hidden')==='false'`)
      }
      await click('PDF Preview')
      await settle()
      assert.equal(await evaluate(`document.querySelector('.latex-agent-pane').getAttribute('aria-hidden')`), 'false')
      await evaluate(`window.changeFixture({active:false})`)
      await waitFor(`document.querySelector('.latex-agent-pane')?.getAttribute('aria-hidden')==='true'`)
      await probeHiddenChat('Inactive workspace')
      await evaluate(`window.changeFixture({active:true})`)
      await settle()
      assert.equal(await evaluate(`window.chatNode===document.querySelector('.latex-agent-terminal .xterm')`), true)
      assert.equal(await evaluate(`document.querySelector('.latex-composer textarea').value`), 'Keep this unsent draft')
      assert.equal(await evaluate(`window.attaches.filter(id=>id==='writing-chat').length`), 1)
      await evaluate(`window.changeFixture({mounted:false})`)
      await waitFor('window.dataListeners.size===0 && window.transportListeners.size===0')
      assert.deepEqual(await evaluate('window.backendMutations'), [], 'Eviction/hiding/unmounting never stops a backend')
      assert.deepEqual(await evaluate('window.errors'), [])
      process.stdout.write(`Terminal surface UI passed: real xterm counts ${counts.join(' → ')}, four-surface LRU, subscription cleanup, warm reuse, unchanged tab order, and hidden LaTeX input/resize suppression with preserved chat/draft.\n`)
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
    import React,{useCallback,useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {PaneWorkspaceStack} from './src/renderer/src/components/PaneWorkspaceStack';
    import {LatexProjectWorkspace} from './src/renderer/src/components/LatexProjectWorkspace';
    window.errors=[];
    window.addEventListener('error',event=>window.errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.errors.push(String(event.reason)));
    window.dataListeners=new Set();window.transportListeners=new Set();
    window.attaches=[];window.writes=[];window.resizes=[];window.prompts=[];window.backendMutations=[];
    const observers=new Map();const NativeResizeObserver=window.ResizeObserver;
    window.ResizeObserver=class extends NativeResizeObserver{
      constructor(callback){super(callback);this.callback=callback}
      observe(target,...args){observers.set(this,{target,callback:this.callback});super.observe(target,...args)}
      disconnect(){observers.delete(this);super.disconnect()}
    };
    window.probeChat=()=>{
      const pane=document.querySelector('.latex-agent-pane');
      for(const {target,callback} of observers.values())if(pane.contains(target))callback();
      pane.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
    };
    const listen=(listeners,callback)=>{listeners.add(callback);return()=>listeners.delete(callback)};
    const noop=()=>{};const asyncNoop=async()=>{};
    window.projectConsole={
      terminals:{
        attach:async(id)=>{window.attaches.push(id);return {output:'Replay for '+id+'\\r\\n'}},
        onData:(callback)=>listen(window.dataListeners,callback),
        onTransport:(callback)=>listen(window.transportListeners,callback),
        resize:async(id,cols,rows)=>{window.resizes.push({id,cols,rows})},
        write:async(id,data)=>{window.writes.push({id,data})},
        stop:async(id)=>{window.backendMutations.push({kind:'stop',id})},
        detach:async(id)=>{window.backendMutations.push({kind:'detach',id})}
      },
      latex:{getWorkspace:async(projectId)=>({details:{projectId,mainFile:'main.tex',contextFolder:'context'},sections:[]}),
        listComments:async()=>[],listInlineEdits:async()=>[],sendPrompt:async(id,text)=>{window.prompts.push({id,text})}},
      system:{copyText:asyncNoop,readText:async()=>'',openExternal:asyncNoop}
    };
    const session=(id,projectId)=>({id,projectId,kind:'terminal',name:id,profile:'shell',backend:'tmux',tmuxName:id,
      state:'idle',archived:false,pinned:false,flagged:false,dangerousMode:false,output:'',latexChat:null,
      providerSessionId:null,providerSessionName:null,customCommand:null,createdAt:'2026-01-01',updatedAt:'2026-01-01'});
    const project=(id)=>({id,type:'terminal',name:id,icon:null,connectionId:'local',folder:'/fixture/'+id,
      repositoryUrl:null,latex:null,state:'idle',archived:false,createdAt:'2026-01-01',updatedAt:'2026-01-01',
      sessions:[session(id+'-first',id),session(id+'-second',id)],actions:[],activities:[]});
    const projects=Array.from({length:5},(_,i)=>project('project-'+i));
    const paper={...project('paper'),type:'latex',sessions:[{...session('writing-chat','paper'),kind:'latex-chat',profile:'codex',
      latexChat:{purpose:'writing',scope:'project',mode:'ask',sectionId:null}}]};
    const connections=[{id:'local',kind:'local',name:'Local'}];
    const openSessionIds=new Set(projects.flatMap(project=>project.sessions.map(session=>session.id)));
    function Fixture(){
      const [state,setState]=useState({index:0,selected:'project-0-second',latex:false,active:true,mounted:true});
      window.changeFixture=(patch)=>setState(current=>({...current,...patch}));
      const select=useCallback(id=>setState(current=>({...current,selected:id})),[]);
      const props={selectedSessionId:state.selected,launchTerminalRequest:null,openSessionRequest:null,workspaceTabRequest:null,
        terminalTransportStates:{},openSessionIds,onOpenSession:noop,onCloseSession:noop,onSessionSelected:noop,
        onLaunchTerminalRequestHandled:noop,onOpenSessionRequestHandled:noop,onWorkspaceTabRequestHandled:noop,
        onWorkspaceDestinationVisited:noop,onSelectSession:select,onChanged:asyncNoop};
      if(!state.mounted)return null;
      return state.latex
        ? <LatexProjectWorkspace {...props} project={paper} connection={connections[0]} workspaceActive={state.active}/>
        : <PaneWorkspaceStack {...props} activeProject={projects[state.index]} projects={projects} connections={connections} workspaceFocused/>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `
}
