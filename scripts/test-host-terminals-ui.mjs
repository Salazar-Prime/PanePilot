import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-host-terminals-ui-'))
  try {
    const result = await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, define: { 'import.meta.env.DEV': 'false' },
      outfile: join(temp, 'fixture.js'), write: false })
    for (const output of result.outputFiles) await writeFile(output.path, output.contents)
    const globalStyles = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${globalStyles}</style><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
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
  setTimeout(() => { process.stderr.write('Host terminals UI test timed out.\n'); app.exit(1) }, 45_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1200, height: 800, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const pause = (ms) => new Promise((done) => setTimeout(done, ms))
    const waitFor = async (code) => {
      for (let i = 0; i < 150; i++) {
        if (await evaluate(code)) return
        await pause(20)
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.click()`)
    const key = (key, modifiers = {}) => evaluate(`(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,...${JSON.stringify(modifiers)}}))`)
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor(`window.hostFixture && window.hostFixture.ready`)
      await waitFor(`window.hostFixture.listCalls > 0`)
      assert.equal(await evaluate(`!!document.querySelector('.host-terminals-dialog')`), false, 'Host terminal panel starts hidden')
      assert.equal(await evaluate(`!!document.querySelector('.host-terminal-toolbar')`), false, 'Automatic toolbar action starts hidden when there are no sessions')

      await evaluate(`document.getElementById('host-terminal-opener').focus();document.getElementById('host-terminal-opener').click()`)
      await waitFor(`window.hostFixture.sessions.length===1 && !!document.querySelector('.host-terminals-dialog')`)
      await waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`)
      assert.equal(await evaluate(`document.querySelector('.host-terminal-toolbar')?.getAttribute('aria-label')`), 'Host terminals (1 open)')
      assert.equal(await evaluate(`document.querySelectorAll('[data-pinned-action="host-terminals"]').length`), 0)
      await waitFor(`window.hostFixture.attaches.includes('host-1')`)
      await waitFor(`document.querySelector('.xterm-rows')?.textContent.includes('Host fixture1 ready')`)
      assert.equal(await evaluate(`document.querySelector('.xterm-rows').textContent.includes('Host fixture1 ready')`), true,
        'The selected host bridge output appears in the real xterm surface')

      // Delay the second synthetic create so pending-state, duplicate guards,
      // and Escape blocking can be exercised without ever launching a shell.
      await evaluate(`window.hostFixture.delayCreate=true`)
      await click('.host-terminals-new')
      await waitFor(`window.hostFixture.createCalls===2 && document.querySelector('.host-terminals-new')?.disabled`)
      await key('Escape')
      await pause(50)
      assert.equal(await evaluate(`!!document.querySelector('.host-terminals-dialog')`), true, 'Escape cannot dismiss while creation is pending')
      assert.equal(await evaluate(`window.hostFixture.createCalls`), 2, 'A pending create cannot be duplicated')
      await evaluate(`window.hostFixture.resolveCreate()`)
      await waitFor(`window.hostFixture.sessions.length===2 && !document.querySelector('.host-terminals-new')?.disabled`)
      await evaluate(`window.hostFixture.delayCreate=false`)
      await waitFor(`window.hostFixture.attaches.includes('host-2')`)
      assert.deepEqual(await evaluate(`window.hostFixture.sessions.map(s=>s.name)`), ['Host fixture1', 'Host fixture2'])
      assert.equal(await evaluate(`new Set(window.hostFixture.sessions.map(s=>s.id)).size`), 2, 'Host terminal IDs are unique')

      await evaluate(`document.getElementById('host-project-switch').click()`)
      assert.equal(await evaluate(`document.getElementById('project-name').textContent`), 'SSH fixture project')
      assert.equal(await evaluate(`window.hostFixture.sessions.length`), 2, 'Changing projects does not change host terminal state')

      await evaluate(`document.querySelectorAll('[role="tab"]')[0].click()`)
      await waitFor(`document.querySelector('[data-host-terminal-id="host-1"]')`)
      await waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`)

      // A superseded attach may finish late, but must not steal focus or put
      // the other host's replay into the selected terminal surface.
      await evaluate(`window.hostFixture.deferAttachId='host-2';document.querySelectorAll('[role="tab"]')[1].click()`)
      await waitFor(`window.hostFixture.pendingAttaches.some(a=>a.id==='host-2')`)
      await evaluate(`document.querySelectorAll('[role="tab"]')[0].click()`)
      await waitFor(`document.querySelector('[data-host-terminal-id="host-1"]') && document.activeElement?.classList.contains('xterm-helper-textarea')`)
      await evaluate(`window.hostFixture.resolveAttach('host-2')`)
      await pause(80)
      await evaluate(`window.hostFixture.deferAttachId=null`)
      assert.equal(await evaluate(`document.querySelector('[data-host-terminal-id="host-1"]')!==null`), true, 'A late attach cannot replace the newly selected terminal')
      assert.equal(await evaluate(`document.activeElement?.closest('[data-host-terminal-id="host-1"]')!==null`), true, 'A late attach cannot steal terminal focus')
      assert.equal(await evaluate(`document.querySelector('.xterm-rows')?.textContent.includes('Host fixture1 ready')`), true, 'A late replay cannot replace the selected terminal output')
      window.webContents.sendInputEvent({ type: 'char', keyCode: 'q' })
      await waitFor(`window.hostFixture.writes.some(w=>w.id==='host-1'&&w.data==='q')`)
      assert.deepEqual(await evaluate(`window.hostFixture.writes.map(w=>w.id)`), ['host-1'], 'Typed input routes through only the host terminal bridge')
      assert.equal(await evaluate(`window.hostFixture.projectTerminalCalls.length`), 0, 'The project terminal bridge is never used')

      // Tab is a shell key while xterm owns focus; it must not be consumed by
      // the modal shortcut/focus boundary.
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' })
      await waitFor(`window.hostFixture.writes.some(w=>w.id==='host-1'&&w.data==='\\t')`)
      assert.equal(await evaluate(`document.activeElement?.classList.contains('xterm-helper-textarea')`), true, 'Tab remains in the active shell')

      const terminalPoint = await evaluate(`(()=>{const r=document.querySelector('.terminal-host').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
      await evaluate(`document.querySelector('.terminal-host').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:${terminalPoint.x},clientY:${terminalPoint.y}}))`)
      await waitFor(`!!document.querySelector('.host-terminal-clipboard-menu')`)
      const menuPoint = await evaluate(`(()=>{const r=document.querySelector('.host-terminal-clipboard-menu').getBoundingClientRect();return {x:Math.round(r.left+10),y:Math.round(r.top+10)}})()`)
      assert.equal(await evaluate(`document.elementFromPoint(${menuPoint.x},${menuPoint.y})?.closest('.host-terminal-clipboard-menu')!==null`), true,
        'Host terminal clipboard menu paints above the modal backdrop')
      await evaluate(`Array.from(document.querySelectorAll('.host-terminal-clipboard-menu button')).find(button=>button.textContent.includes('Copy full tmux buffer')).click()`)
      await waitFor(`window.hostFixture.capturedBufferIds.includes('host-1') && window.hostFixture.copiedText.at(-1)==='Host replay host-1'`)
      assert.deepEqual(await evaluate(`window.hostFixture.capturedBufferIds`), ['host-1'], 'Full tmux buffer copy uses the host terminal bridge')
      await evaluate(`document.querySelector('.xterm-helper-textarea').focus()`)
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['meta'] })
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['meta'] })
      await waitFor(`window.hostFixture.readTextCalls===1 && window.hostFixture.writes.some(w=>w.id==='host-1'&&w.data.includes('host paste payload'))`)
      assert.equal(await evaluate(`window.hostFixture.writes.filter(w=>w.id==='host-1').at(-1).data.includes('host paste payload')`), true, 'Cmd+V routes paste through the selected host terminal bridge')
      assert.equal(await evaluate(`window.hostFixture.projectTerminalCalls.length`), 0, 'Host clipboard actions never touch project terminal APIs')

      await key('2', { metaKey: true })
      await waitFor(`document.querySelector('[data-host-terminal-id="host-2"]')`)
      await waitFor(`window.hostFixture.attaches.includes('host-2') && document.activeElement?.classList.contains('xterm-helper-textarea')`)
      assert.equal(await evaluate(`document.querySelector('[role="tab"][aria-selected="true"] .host-terminals-tab-name').textContent`), 'Host fixture2', 'Command+2 selects the second host session')
      window.webContents.sendInputEvent({ type: 'char', keyCode: 'w' })
      await waitFor(`window.hostFixture.writes.some(w=>w.id==='host-2'&&w.data==='w')`)
      assert.deepEqual(await evaluate(`window.hostFixture.writes.map(w=>w.id)`), ['host-1', 'host-1', 'host-1', 'host-2'], 'Input follows the selected host session')
      await key('1', { ctrlKey: true })
      await waitFor(`document.querySelector('[data-host-terminal-id="host-1"]')`)
      assert.equal(await evaluate(`document.querySelector('[role="tab"][aria-selected="true"] .host-terminals-tab-name').textContent`), 'Host fixture1', 'Control+1 selects the first host session')

      await evaluate(`document.getElementById('host-terminals-pin').click()`)
      assert.equal(await evaluate(`document.querySelectorAll('[data-pinned-action="host-terminals"]').length`), 1)
      assert.equal(await evaluate(`!!document.querySelector('.host-terminal-toolbar')`), false, 'Pinning suppresses the automatic toolbar duplicate')
      await key('Escape')
      await waitFor(`!document.querySelector('.host-terminals-dialog')`)
      assert.equal(await evaluate(`window.hostFixture.sessions.length`), 2, 'Hiding leaves host sessions running')
      assert.equal(await evaluate(`document.activeElement.id`), 'host-terminal-opener', 'Escape restores focus to the opener')
      assert.equal(await evaluate(`document.querySelectorAll('[data-pinned-action="host-terminals"]').length`), 1, 'Pinned action remains available while the panel is hidden')
      await evaluate(`document.querySelector('[data-pinned-action="host-terminals"] button').focus();document.querySelector('[data-pinned-action="host-terminals"] button').click()`)
      await waitFor(`!!document.querySelector('.host-terminals-dialog')`)
      assert.equal(await evaluate(`window.hostFixture.sessions.length`), 2, 'Reopening restores the existing host sessions')
      await key('Escape')
      await waitFor(`!document.querySelector('.host-terminals-dialog')`)
      assert.equal(await evaluate(`document.activeElement?.closest('[data-pinned-action="host-terminals"]')!==null`), true, 'Escape restores the explicitly focused pinned opener')
      await evaluate(`document.querySelector('[data-pinned-action="host-terminals"] button').focus();document.querySelector('[data-pinned-action="host-terminals"] button').click()`)
      await waitFor(`!!document.querySelector('.host-terminals-dialog')`)

      // Closing is a parent-owned confirmation request; cancel has no bridge
      // effect, and confirmation closes only the exact requested session.
      await evaluate(`document.querySelector('[aria-label="Close Host fixture1"]').click()`)
      await waitFor(`window.hostFixture.removeRequests.at(-1)==='host-1'`)
      assert.equal(await evaluate(`window.hostFixture.sessions.length`), 2, 'Requesting close does not mutate the bridge collection')
      assert.equal(await evaluate(`window.hostFixture.projectTerminalCalls.length`), 0)
      await evaluate(`window.hostFixture.respondRemove(false)`)
      await pause(40)
      assert.equal(await evaluate(`window.hostFixture.sessions.length`), 2, 'Canceling close leaves both sessions intact')
      await evaluate(`document.querySelector('[aria-label="Close Host fixture1"]').click()`)
      await waitFor(`window.hostFixture.removeRequests.length===2`)
      await evaluate(`window.hostFixture.respondRemove(true)`)
      await waitFor(`window.hostFixture.sessions.length===1 && !!document.querySelector('[data-host-terminal-id="host-2"]')`)
      assert.deepEqual(await evaluate(`window.hostFixture.sessions.map(s=>s.id)`), ['host-2'], 'Confirming close removes only the exact requested host session')
      await evaluate(`document.querySelector('[aria-label="Close Host fixture2"]').click()`)
      await waitFor(`window.hostFixture.removeRequests.length===3`)
      await evaluate(`window.hostFixture.respondRemove(true)`)
      await waitFor(`window.hostFixture.sessions.length===0`)
      assert.equal(await evaluate(`!!document.querySelector('.host-terminal-toolbar')`), false)
      assert.equal(await evaluate(`document.querySelectorAll('[data-pinned-action="host-terminals"]').length`), 1, 'Pinned action persists with zero sessions')

      await evaluate(`document.getElementById('host-terminals-pin').click()`)
      assert.equal(await evaluate(`document.querySelectorAll('[data-pinned-action="host-terminals"]').length`), 0)
      await key('Escape')
      await waitFor(`!document.querySelector('.host-terminals-dialog')`)
      await evaluate(`document.getElementById('host-terminal-opener').focus();document.getElementById('host-terminal-opener').click()`)
      await waitFor(`!!document.querySelector('.host-terminals-dialog')`)
      await waitFor(`window.hostFixture.sessions.length===1`)
      assert.equal(await evaluate(`window.hostFixture.sessions.length`), 1, 'Opening from the toolbar with no sessions creates one synthetic session')
      assert.equal(await evaluate(`document.querySelectorAll('.host-terminal-toolbar').length`), 1, 'One automatic toolbar action appears for the new session')

      await evaluate(`window.hostFixture.failCreate=true;document.querySelector('.host-terminals-new').click()`)
      await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Fixture create failed')`)
      await key('Escape')
      await waitFor(`!document.querySelector('.host-terminals-dialog')`)
      assert.equal(await evaluate(`document.activeElement.id`), 'host-terminal-opener', 'Error dismissal restores focus to the opener')
      assert.equal(await evaluate(`window.hostFixture.projectTerminalCalls.length`), 0, 'No project terminal APIs were touched')
      assert.equal(await evaluate(`window.hostFixture.sessionIds.every(id=>id.startsWith('host-'))`), true)

      if (process.env.PANEPILOT_UI_SCREENSHOT) {
        await evaluate(`document.getElementById('host-terminal-opener').click()`)
        await waitFor(`!!document.querySelector('.host-terminals-dialog')`)
        await waitFor(`document.activeElement?.classList.contains('xterm-helper-textarea')`)
        await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
        await pause(220)
        const bounds = await evaluate(`(()=>{const rect=document.querySelector('.host-terminals-dialog').getBoundingClientRect();return {width:rect.width,height:rect.height}})()`)
        assert.ok(bounds.width > 500 && bounds.height > 300, `Host terminals dialog painted at ${bounds.width}×${bounds.height}`)
        await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      }
      process.stdout.write('Host terminals UI passed: synthetic host-only sessions, toolbar and pin visibility, project independence, real xterm input routing, keyboard session selection, pending-create guard, hide/reopen, exact close confirmation, and error handling.\n')
      window.destroy()
      app.exit(0)
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`)
      window.destroy()
      app.exit(1)
    }
  })
}

function fixture() {
  return `
    import React, {useState} from 'react';import {createRoot} from 'react-dom/client';import '@xterm/xterm/css/xterm.css';
    import {TerminalSquare} from 'lucide-react';
    import {HostTerminalsPanel} from './src/renderer/src/components/HostTerminalsPanel';
    import {HostTerminalToolbarAction} from './src/renderer/src/components/HostTerminalToolbarAction';
    import {PinnedToolbarActions} from './src/renderer/src/components/PinnedToolbarActions';
    import {useHostTerminals} from './src/renderer/src/lib/useHostTerminals';
    const fake={sessions:[],createCalls:0,listCalls:0,attaches:[],pendingAttaches:[],deferAttachId:null,writes:[],capturedBufferIds:[],copiedText:[],readTextCalls:0,removeRequests:[],projectTerminalCalls:[],sessionIds:[],listeners:new Set(),dataListeners:new Set(),transportListeners:new Set(),delayCreate:false,failCreate:false,resolveCreate:null,removePending:null};
    const clone=()=>fake.sessions.map(s=>({...s}));
    const emit=()=>{for(const listener of fake.listeners)listener(clone())};
    const record=n=>{const session={id:'host-'+n,name:'Host fixture'+n,profile:'shell',backend:'tmux',tmuxName:'panepilot-fixture-'+n,state:'idle',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};fake.sessionIds.push(session.id);fake.sessions.push(session);emit();return session};
    const api={list:async()=>{fake.listCalls++;return clone()},create:async()=>{const n=++fake.createCalls;if(fake.failCreate)throw Error('Fixture create failed');if(fake.delayCreate)return new Promise(resolve=>{fake.resolveCreate=()=>resolve(record(n))});return record(n)},close:async id=>{const index=fake.sessions.findIndex(s=>s.id===id);if(index>=0){fake.sessions.splice(index,1);emit()}},onChanged:listener=>{fake.listeners.add(listener);return()=>fake.listeners.delete(listener)},
      attach:async(id)=>{fake.attaches.push(id);const output='\\x1b[32mHost fixture'+(Number(id.split('-')[1]))+' ready\\x1b[0m\\r\\n$ ';if(fake.deferAttachId===id)return new Promise(resolve=>fake.pendingAttaches.push({id,resolve:()=>resolve({output})}));return{output}},retryAttach:async()=>{},captureBuffer:async id=>{fake.capturedBufferIds.push(id);return'Host replay '+id},resize:async()=>{},write:async(id,data)=>{fake.writes.push({id,data})},onData:listener=>{fake.dataListeners.add(listener);return()=>fake.dataListeners.delete(listener)},onTransport:listener=>{fake.transportListeners.add(listener);return()=>fake.transportListeners.delete(listener)}};
    fake.resolveAttach=id=>{const index=fake.pendingAttaches.findIndex(attach=>attach.id===id);if(index>=0)fake.pendingAttaches.splice(index,1)[0].resolve()};
    window.hostFixture=fake;window.projectConsole={hostTerminals:api,terminals:new Proxy({}, {get:(_,name)=> (...args)=>{fake.projectTerminalCalls.push(String(name));throw Error('Unexpected project terminal call: '+String(name))}}),system:{copyText:async text=>{fake.copiedText.push(text)},readText:async()=>{fake.readTextCalls++;return'host paste payload'},openExternal:async()=>{}}};
    function Fixture(){const host=useHostTerminals();const [project,setProject]=useState('Local fixture project');const [pinned,setPinned]=useState(false);const [removeId,setRemoveId]=useState(null);window.hostFixture.ready=true;window.hostFixture.openHost=host.show;window.hostFixture.createHost=host.create;window.hostFixture.requestRemove=id=>{fake.removeRequests.push(id);setRemoveId(id)};window.hostFixture.respondRemove=async confirmed=>{const id=removeId;if(confirmed&&id)await host.remove(id);setRemoveId(null)};
      const run=()=>{if(host.sessions.length)host.show();else void host.create().catch(()=>{})};const actions=[{id:'host-terminals',label:'Host terminals',icon:<TerminalSquare size={15}/>,available:true,run:host.show}];
      return <><header className="top-bar"><button id="host-terminal-opener" onClick={run}>Host terminals menu</button><button id="host-project-switch" onClick={()=>setProject(v=>v==='Local fixture project'?'SSH fixture project':'Local fixture project')}>Switch project</button><span id="project-name">{project}</span><button id="host-terminals-pin" onClick={()=>setPinned(v=>!v)}>{pinned?'Unpin':'Pin'}</button><HostTerminalToolbarAction count={host.sessions.length} pinned={pinned} active={host.open} onOpen={host.show}/><PinnedToolbarActions ids={pinned?['host-terminals']:[]} actions={actions} onReorder={()=>{}}/></header>
        <div id="root-workspace"><p>Project workspace: {project}</p></div>
        {host.open&&<HostTerminalsPanel sessions={host.sessions} selectedId={host.selectedId} pending={host.pending} error={host.error} onSelect={host.select} onCreate={()=>{void host.create().catch(()=>{})}} onRemove={window.hostFixture.requestRemove} onDismiss={host.dismiss}/>}
        {removeId&&<div id="fixture-confirmation" role="status">Confirm close {removeId}<button onClick={()=>window.hostFixture.respondRemove(false)}>Cancel</button><button onClick={()=>window.hostFixture.respondRemove(true)}>Confirm</button></div>}
      </>
    }
    const root=createRoot(document.getElementById('root'));root.render(<Fixture/>);
  `
}
