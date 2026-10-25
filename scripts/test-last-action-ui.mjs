import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-last-action-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(temp, 'fixture.js') })
    const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${css}html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}#workspace{flex:1;padding:30px}#editor{width:80%;height:80%;background:#090b10;color:#ddd;border:0}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject); child.once('exit', done)
    })
    if (code !== 0) process.exitCode = 1
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  setTimeout(() => { process.stderr.write('Last action UI test timed out.\n'); app.exit(1) }, 40_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1100, height: 700, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const pause = (ms) => new Promise((done) => setTimeout(done, ms))
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await pause(20) }
      throw Error(`UI did not settle: ${code}`)
    }
    const trigger = `document.querySelector('[aria-label="Project tools"] button')`
    const popover = `document.querySelector('.last-action-popover')`
    const hover = async () => {
      const point = await evaluate(`(()=>{const r=${trigger}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      await waitFor(`!!${popover}`)
    }
    const palette = async () => {
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',metaKey:true,bubbles:true}))`)
      await waitFor(`!!document.querySelector('[aria-label="Search commands"]')`)
      await evaluate(`{const input=document.querySelector('[aria-label="Search commands"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'run last action');input.dispatchEvent(new Event('input',{bubbles:true}))}`)
    }
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor(`!!${trigger}`)
      await evaluate(`document.getElementById('editor').focus()`)
      const height = await evaluate(`document.querySelector('.status-bar').getBoundingClientRect().height`)
      await hover()
      assert.equal(await evaluate(`${popover}.querySelector('strong').textContent`), 'Tests')
      assert.equal(await evaluate(`${popover}.querySelector('code').textContent`), 'npm test')
      assert.equal(await evaluate(`document.activeElement.id`), 'editor', 'Hover never steals terminal/editor focus')
      assert.equal(await evaluate(`window.calls.length`), 0)
      assert.equal(await evaluate(`${popover}.closest('.status-workspace-nav')===null`), true, 'The card escapes the clipped footer')
      assert.equal(await evaluate(`document.querySelector('.status-bar').getBoundingClientRect().height`), height)
      const point = await evaluate(`(()=>{const r=${popover}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
      await pause(220)
      assert.equal(await evaluate(`!!${popover}`), true, 'The card remains reachable from its trigger')
      if (process.env.PANEPILOT_UI_SCREENSHOT) await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())

      await evaluate(`${popover}.querySelector('.last-action-run').click();${popover}.querySelector('.last-action-run').click()`)
      await waitFor(`window.calls.length===1 && ${popover}.querySelector('.last-action-run').disabled`)
      assert.deepEqual(await evaluate(`window.calls`), ['p:tests'])
      assert.equal(await evaluate(`window.opened`), 0, 'Quick run stays in the current workspace')
      await palette()
      await waitFor(`document.querySelector('.command-empty')!==null`)
      assert.equal(await evaluate(`window.calls.length`), 1, 'Search cannot execute or duplicate a pending action')
      await evaluate(`window.completeRun()`)
      await waitFor(`window.refreshed.includes('p')`)
      await evaluate(`window.finishRun();window.closePalette()`)
      await waitFor(`!document.querySelector('.command-palette')`)

      await evaluate(`${trigger}.focus()`)
      await waitFor(`!!${popover}`)
      await evaluate(`${trigger}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`)
      assert.equal(await evaluate(`document.activeElement.classList.contains('last-action-run')`), true)
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await waitFor(`!${popover}`)
      assert.equal(await evaluate(`document.activeElement===${trigger}`), true, 'Escape restores focus without reopening')
      await evaluate(`${trigger}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`)
      await waitFor(`!!${popover} && document.activeElement.classList.contains('last-action-run')`)
      await evaluate(`window.dispatchEvent(new Event('blur'))`)
      await waitFor(`!${popover}`)

      // The palette uses the exact same last-run resolver and execution coordinator.
      await palette()
      await waitFor(`document.querySelector('[role="option"] strong')?.textContent==='Run last action'`)
      assert.equal(await evaluate(`document.querySelector('[role="option"] small').textContent`), 'Local project · Tests · npm test')
      await evaluate(`document.querySelector('[role="option"]').click()`)
      await waitFor(`window.calls.length===2`)
      await evaluate(`window.changeProject('remote')`)
      await evaluate(`window.completeRun()`)
      await waitFor(`window.refreshed.length===2`)
      assert.deepEqual(await evaluate(`window.refreshed`), ['p', 'p'], 'An in-flight run refreshes its original project')
      await evaluate(`document.getElementById('editor').focus()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 })
      await hover()
      assert.equal(await evaluate(`${popover}.querySelector('strong').textContent`), 'Remote build')
      await evaluate(`${popover}.querySelector('.last-action-run').click()`)
      await waitFor(`window.calls.at(-1)==='remote:tests'`)
      await evaluate(`window.rejectRun('SSH offline')`)
      await waitFor(`${popover}.querySelector('[role="alert"]')?.textContent==='SSH offline'`)

      await evaluate(`window.changeProject('empty')`)
      await waitFor(`!${popover}`)
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 })
      await hover()
      assert.equal(await evaluate(`${popover}.querySelector('.last-action-run')===null`), true)
      assert.equal(await evaluate(`${popover}.textContent.includes('Run an action once')`), true)
      await evaluate(`${popover}.querySelector('.last-action-open').click()`)
      assert.equal(await evaluate(`window.opened`), 1)
      await evaluate(`window.changeProject('latex')`)
      await palette()
      await waitFor(`document.querySelector('[role="option"] small')?.textContent.includes('LaTeX project')`)
      await evaluate(`document.querySelector('[role="option"]').click()`)
      await waitFor(`window.calls.at(-1)==='latex:tests'`)
      await evaluate(`window.completeRun()`)
      await waitFor(`window.refreshed.at(-1)==='latex'`)
      assert.deepEqual(await evaluate(`window.errors`), [])
      process.stdout.write('Last action UI passed: hover without execution/focus theft, reachable unclipped card, unchanged footer height, exact project/command, duplicate and active guards, keyboard/Escape, shared Command-K execution, project-switch isolation, errors, empty state, and local/SSH/LaTeX parity.\n')
      window.destroy(); app.exit(0)
    } catch (error) { process.stderr.write(`${error.stack ?? error}\n`); window.destroy(); app.exit(1) }
  })
}

function fixture() {
  return `
    import React from 'react';import {createRoot} from 'react-dom/client';import {Play} from 'lucide-react';
    import {LastActionTool} from './src/renderer/src/components/LastActionTool';
    import {StatusWorkspaceNav} from './src/renderer/src/components/StatusWorkspaceNav';
    import {CommandPalette} from './src/renderer/src/components/CommandPalette';
    import {lastProjectAction,lastProjectActionCommand} from './src/renderer/src/lib/lastProjectAction';
    import {runProjectAction,useActionRunPending} from './src/renderer/src/lib/actionRuns';
    const projects=Object.fromEntries(['p','remote','empty','latex'].map(id=>[id,{id,name:id==='p'?'Local project':id==='latex'?'LaTeX project':'SSH project',type:id==='latex'?'latex':'terminal',connectionId:id==='p'?'local':'ssh:fixture',archived:false,
      actions:id==='empty'?[]:[{id:id+':build',projectId:id,name:'Build',command:'npm run build',lastSessionId:id+':old'},{id:id+':tests',projectId:id,name:id==='remote'?'Remote build':'Tests',command:'npm test',lastSessionId:id+':recent'}],
      sessions:[{id:id+':old',projectId:id,kind:'action',createdAt:'2026-10-01',state:'completed'},{id:id+':recent',projectId:id,kind:'action',createdAt:'2026-10-24',state:'completed'}]}]));
    let projectId='p',showPalette=false,runNumber=0;window.calls=[];window.refreshed=[];window.opened=0;window.errors=[];
    window.addEventListener('error',e=>window.errors.push(e.message));
    window.projectConsole={actions:{run:async id=>{window.calls.push(id);return new Promise((resolve,reject)=>{window.completeRun=()=>{const owner=Object.values(projects).find(p=>p.actions.some(a=>a.id===id));const session={id:'run-'+(++runNumber),projectId:owner.id,kind:'action',createdAt:'2026-10-25',state:'running'};owner.sessions.push(session);owner.actions.find(a=>a.id===id).lastSessionId=session.id;resolve(session)};window.rejectRun=message=>reject(Error(message))})}}};
    const refresh=async id=>{window.refreshed.push(id);render()};
    function Fixture(){const project=projects[projectId];const last=lastProjectAction(project);const pending=useActionRunPending(last?.action.id??null);
      const command=lastProjectActionCommand(project,pending,async(pid,id)=>{await runProjectAction(id,()=>refresh(pid))});
      return <><main id="workspace"><textarea id="editor" defaultValue="Current terminal stays active"/></main><footer className="status-bar"><div/><div id="status-workspace-nav"/><div/></footer>
        <StatusWorkspaceNav active><nav className="workspace-tabs" aria-label="Project tools"><LastActionTool project={project} active={false} onOpen={()=>window.opened++} onChanged={()=>refresh(project.id)}/><button>Files</button></nav></StatusWorkspaceNav>
        <CommandPalette open={showPalette} commands={command?[{...command,icon:<Play size={15}/>}]:[]} onClose={()=>{showPalette=false;render()}} onError={e=>window.errors.push(e.message)}/></>;
    }
    const root=createRoot(document.getElementById('root'));const render=()=>root.render(<Fixture/>);
    window.changeProject=id=>{projectId=id;render()};window.finishRun=()=>{for(const p of Object.values(projects))for(const s of p.sessions)s.state='completed';render()};
    window.closePalette=()=>{showPalette=false;render()};window.addEventListener('keydown',e=>{if(e.metaKey&&e.key==='k'){showPalette=true;render()}});render();
  `
}
