import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-action-popup-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, define: { 'import.meta.env.DEV': 'false' },
      outfile: join(temp, 'fixture.js') })
    const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${css}
      html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}
      #workspace{flex:1;display:flex;min-height:0}#sidebar{width:240px;padding:30px 15px;background:#0e1016}
      #editor{flex:1;margin:25px;background:#090b10;color:#adb3c0;border:0}
      .status-bar{flex:0 0 26px;height:26px}.session-row{margin:6px 0}
    </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
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
  setTimeout(() => app.exit(1), 45_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1100, height: 700, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const pause = (ms) => new Promise((done) => setTimeout(done, ms))
    const waitFor = async (code) => { for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await pause(20) }; throw Error(`UI did not settle: ${code}`) }
    const trigger = `document.querySelector('[aria-label="Project tools"] button')`
    const popup = `document.querySelector('.last-action-popover')`
    const hover = async () => {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 400, y: 300 })
      await pause(30)
      const point = await evaluate(`(()=>{const r=${trigger}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await waitFor(`!!${popup}`)
    }
    try {
      await window.loadFile(join(temp, 'index.html')); await waitFor(`!!${trigger}`)
      await evaluate(`document.querySelector('[data-status-filter="working"]').click()`)
      await waitFor(`!!document.getElementById('status-session-menu')`)
      const reference = await evaluate(`(()=>{const el=document.getElementById('status-session-menu'),s=getComputedStyle(el);return {background:s.backgroundColor,border:s.borderColor,radius:s.borderRadius,shadow:s.boxShadow,header:getComputedStyle(el.querySelector('header')).padding}})()`)
      await evaluate(`document.querySelector('.status-session-close').click();document.getElementById('editor').focus()`)
      const height = await evaluate(`document.querySelector('.status-bar').getBoundingClientRect().height`)
      await hover()
      assert.equal(await evaluate(`${popup}.querySelector('.last-action-run strong').textContent`), 'Tests', 'Fallback honors saved manual action order')
      assert.equal(await evaluate(`${popup}.querySelector('[role="status"]').textContent`), 'First actionReady to run')
      assert.equal(await evaluate(`document.activeElement.id`), 'editor', 'Hover does not steal focus')
      assert.equal(await evaluate(`window.calls.length`), 0, 'Hover never executes commands')
      assert.deepEqual(await evaluate(`(()=>{const el=${popup},s=getComputedStyle(el);return {background:s.backgroundColor,border:s.borderColor,radius:s.borderRadius,shadow:s.boxShadow,header:getComputedStyle(el.querySelector('header')).padding}})()`), reference, 'Uses the same bottom-bar popup skin')
      assert.equal(await evaluate(`document.querySelector('.status-bar').getBoundingClientRect().height`), height)
      assert.equal(await evaluate(`${popup}.closest('.status-workspace-nav')===null`), true, 'Popup escapes footer clipping')
      const point = await evaluate(`(()=>{const r=${popup}.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      window.webContents.sendInputEvent({ type: 'mouseMove', ...point }); await pause(220)
      assert.equal(await evaluate(`!!${popup}`), true, 'Hover bridge keeps Run reachable')

      await evaluate(`${popup}.querySelector('.last-action-run').click();${popup}.querySelector('.last-action-run').click()`)
      await waitFor(`window.calls.length===1 && ${popup}.querySelector('.last-action-run').disabled`)
      assert.equal(await evaluate(`${popup}.querySelector('[role="status"] strong').textContent`), 'Starting…')
      await evaluate(`window.completeRun()`); await waitFor(`${popup}.querySelector('[role="status"] strong').textContent==='Running'`)
      assert.equal(await evaluate(`${popup}.querySelector('.status-running')!==null`), true)
      assert.equal(await evaluate(`window.opened`), 0, 'Run leaves the current capability open')
      await evaluate(`${popup}.querySelector('.last-action-run').click()`)
      assert.equal(await evaluate(`window.calls.length`), 1, 'Running action cannot be launched twice')
      await evaluate(`window.finishRun('completed');window.reorder(['p:build','p:tests'])`)
      await waitFor(`${popup}.querySelector('[role="status"] strong').textContent==='Finished'`)
      assert.equal(await evaluate(`${popup}.querySelector('.last-action-run strong').textContent`), 'Tests', 'Last run wins over grid order')

      await evaluate(`${popup}.querySelector('.status-session-close').click()`); await waitFor(`!${popup}`)
      assert.equal(await evaluate(`document.activeElement===${trigger}`), true)
      await evaluate(`${trigger}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`)
      await waitFor(`!!${popup} && document.activeElement.classList.contains('last-action-run')`)
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`); await waitFor(`!${popup}`)
      assert.equal(await evaluate(`document.activeElement===${trigger}`), true, 'Escape restores focus without reopening')

      await hover(); await evaluate(`${popup}.querySelector('.last-action-run').click()`); await waitFor(`window.calls.length===2`)
      await evaluate(`window.changeProject('remote');window.completeRun()`); await waitFor(`window.refreshed.length===2`)
      assert.deepEqual(await evaluate(`window.refreshed`), ['p', 'p'], 'Delayed launch only refreshes its original project')
      await evaluate(`document.getElementById('editor').focus()`); await hover()
      assert.equal(await evaluate(`${popup}.querySelector('.last-action-run strong').textContent`), 'Build')
      await evaluate(`${popup}.querySelector('.last-action-run').click()`); await waitFor(`window.calls.at(-1)==='remote:build'`)
      await evaluate(`window.rejectRun('SSH offline')`); await waitFor(`${popup}.querySelector('[role="alert"]').textContent==='SSH offline'`)
      await evaluate(`window.changeProject('empty')`); await waitFor(`!${popup}`); await hover()
      assert.equal(await evaluate(`${popup}.querySelector('.last-action-run')===null`), true)
      await evaluate(`${popup}.querySelector('.last-action-open').click()`)
      assert.equal(await evaluate(`window.opened`), 1)
      await evaluate(`window.changeProject('latex')`); await hover()
      await evaluate(`${popup}.querySelector('.last-action-run').click()`); await waitFor(`window.calls.at(-1)==='latex:build'`)
      await evaluate(`window.completeRun()`); await waitFor(`window.refreshed.at(-1)==='latex'`)
      assert.equal(await evaluate(`${popup}.querySelector('[role="status"] strong').textContent`), 'Running')

      const colors = await evaluate(`(()=>{const selected=getComputedStyle(document.querySelector('#selected-row'));return {selected:selected.backgroundColor,inactive:getComputedStyle(document.querySelector('#inactive-row')).backgroundColor,attention:getComputedStyle(document.querySelector('#attention-row')).backgroundColor,yellow:getComputedStyle(document.querySelector('#attention-row .label')).color}})()`)
      assert.equal(colors.selected, 'rgb(44, 47, 54)'); assert.equal(colors.attention, colors.selected)
      assert.notEqual(colors.inactive, colors.selected); assert.equal(colors.yellow, 'rgb(242, 198, 109)', 'Attention yellow survives the greyer selection')
      assert.deepEqual(await evaluate('window.errors'), [])
      if (process.env.PANEPILOT_UI_SCREENSHOT) {
        await evaluate(`document.getElementById('editor').focus()`); await hover()
        await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await pause(200)
        await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      }
      process.stdout.write('Action popup passed: ordered first-action fallback, last-run priority, direct Run, Starting/Running/Finished, duplicate guards, shared popup design, keyboard/hover safety, original-project refresh, local/SSH/LaTeX parity, and greyer sidebar selection with yellow attention retained.\n')
      window.destroy(); app.exit(0)
    } catch (cause) { process.stderr.write(`${cause.stack ?? cause}\n`); window.destroy(); app.exit(1) }
  })
}

function fixture() {
  return `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {LastActionTool} from './src/renderer/src/components/LastActionTool';
    import {StatusWorkspaceNav} from './src/renderer/src/components/StatusWorkspaceNav';
    import {StatusSessionMenu} from './src/renderer/src/components/StatusSessionMenu';
    import {StatusDot} from './src/renderer/src/components/StatusDot';
    const projects=Object.fromEntries(['p','remote','empty','latex'].map(id=>[id,{id,name:id==='p'?'Local project':id==='latex'?'LaTeX project':'SSH project',type:id==='latex'?'latex':'terminal',connectionId:id==='p'?'local':'ssh:fixture',archived:false,
      actions:id==='empty'?[]:['build','tests'].map(name=>({id:id+':'+name,projectId:id,name:name==='build'?'Build':'Tests',command:name==='build'?'npm run build':'npm test',lastSessionId:null})),sessions:[]}]));
    let projectId='p',runNumber=0;window.calls=[];window.refreshed=[];window.opened=0;window.errors=[];
    window.addEventListener('error',e=>window.errors.push(e.message));
    localStorage.setItem('panepilot.action-order.v1:p',JSON.stringify(['p:tests','p:build']));
    window.projectConsole={actions:{run:async id=>{window.calls.push(id);return new Promise((resolve,reject)=>{window.completeRun=()=>{const owner=Object.values(projects).find(p=>p.actions.some(a=>a.id===id));const session={id:'run-'+(++runNumber),projectId:owner.id,kind:'action',createdAt:new Date().toISOString(),state:'running'};owner.sessions.push(session);owner.actions.find(a=>a.id===id).lastSessionId=session.id;resolve(session)};window.rejectRun=message=>reject(Error(message))})}}};
    const refresh=async id=>{window.refreshed.push(id);render()};
    const referenceProject={...projects.p,sessions:[{id:'reference',projectId:'p',name:'Reference terminal',profile:'shell',state:'running',kind:'terminal',archived:false}]};
    function Fixture(){const project=projects[projectId];return <><main id="workspace"><aside id="sidebar"><p>Sidebar selection</p>{['inactive','selected','attention'].map((name,i)=><div id={name+'-row'} key={name} className={'session-row '+(i?'selected ':'')+(i===2?'attention-state':'')}><button className="sidebar-row-main"><StatusDot state={i===2?'needs-input':'idle'} compact/><span className="label">{i===0?'Other terminal':i===1?'Active terminal':'Needs your input'}</span></button></div>)}</aside><textarea id="editor" defaultValue="Current terminal stays active"/></main>
      <footer className="status-bar"><div/><div id="status-workspace-nav" className="status-workspace-nav"/><div className="status-right"><StatusSessionMenu projects={[referenceProject]} connections={[{id:'local',name:'This computer'}]} onSelect={()=>{}}/></div></footer>
      <StatusWorkspaceNav active><nav className="workspace-tabs" aria-label="Project tools"><LastActionTool project={project} active={false} onOpen={()=>window.opened++} onChanged={()=>refresh(project.id)}/><button>Files</button></nav></StatusWorkspaceNav></>}
    const root=createRoot(document.getElementById('root'));const render=()=>root.render(<Fixture/>);
    window.changeProject=id=>{projectId=id;render()};window.finishRun=state=>{for(const p of Object.values(projects))for(const s of p.sessions)s.state=state;render()};
    window.reorder=ids=>{localStorage.setItem('panepilot.action-order.v1:p',JSON.stringify(ids));window.dispatchEvent(new CustomEvent('panepilot-action-order-changed',{detail:{projectId:'p',ids}}))};render();
  `
}
