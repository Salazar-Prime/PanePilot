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
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-updates-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root }, bundle: true,
      platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js') })
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
  setTimeout(() => app.exit(1), 25_000).unref()
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1000, height: 700, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await new Promise((done) => setTimeout(done, 20)) }
      throw new Error(`UI did not settle: ${code}`)
    }
    const click = (label) => evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`)
    const escape = () => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    try {
      await window.loadURL('data:text/html,<div id="root"></div>')
      await window.webContents.insertCSS(await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8'))
      await window.webContents.insertCSS(await readFile(join(root, 'src/renderer/src/app-updates.css'), 'utf8'))
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await waitFor(`window.subscriptions===1`)
      await evaluate(`window.emit({phase:'idle'})`)
      assert.equal(await evaluate(`!!document.querySelector('.app-update-toolbar-action')`), false)
      await evaluate(`window.emit({phase:'checking',background:true})`)
      assert.equal(await evaluate(`!!document.querySelector('.app-update-toolbar-action')`), false)
      await evaluate(`window.emit({phase:'error'})`)
      assert.equal(await evaluate(`!!document.querySelector('.app-update-toolbar-action')`), false)
      await evaluate(`window.emit({phase:'downloading',version:'0.16.0'})`)
      await waitFor(`!!document.querySelector('button[aria-label="Update available"]')`)
      await evaluate(`document.querySelector('.app-update-toolbar-action').click()`)
      await waitFor(`!!document.querySelector('[role="dialog"]')`)
      assert.equal(await evaluate(`window.checks`), 0, 'The automatic action opens controls without restarting or checking again')
      await escape()
      await evaluate(`window.pin(true)`)
      await waitFor(`!!document.querySelector('[data-pinned-action="app-updates"]')`)
      assert.equal(await evaluate(`!!document.querySelector('.app-update-toolbar-action')`), false, 'A pin never duplicates the automatic action')
      assert.equal(await evaluate(`!!document.querySelector('.top-pinned-action .app-update-icon-dot')`), true, 'Pinned action shows availability too')
      await evaluate(`window.pin(false);window.emit({phase:'idle',background:false})`)
      await waitFor(`!document.querySelector('.app-update-toolbar-action')`)
      await evaluate(`document.getElementById('opener').focus();document.getElementById('opener').click()`)
      await waitFor(`!!document.querySelector('[role="dialog"]')`)
      assert.equal(await evaluate(`window.checks`), 0, 'Opening controls is not permission to download')
      await click('Check for updates')
      await waitFor(`document.querySelector('[role="status"]')?.textContent==='Checking…'`)
      await escape()
      await waitFor(`!document.querySelector('[role="dialog"]')`)
      assert.equal(await evaluate(`document.activeElement.id`), 'opener')
      await evaluate(`window.emit({phase:'downloading',percent:42,message:'Downloading…'});document.getElementById('opener').click()`)
      await waitFor(`document.querySelector('progress')?.value===42`)
      await evaluate(`window.emit({phase:'ready',version:'0.16.0',message:'Update ready.'});window.resolveInitial({...window.state,phase:'idle'})`)
      await waitFor(`document.querySelector('h2')?.textContent==='Version 0.16.0 is ready'`)
      assert.equal(await evaluate(`!!document.querySelector('button[aria-label="Update ready"]')`), true)
      if (process.env.PANEPILOT_UI_SCREENSHOT) {
        await evaluate(`new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`)
        await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      }
      await evaluate(`window.guard(true)`)
      await click('Restart to update')
      await waitFor(`document.querySelector('[role="alert"]')?.textContent==='Save the cached file first.'`)
      assert.equal(await evaluate(`window.restarts`), 0)
      await evaluate(`window.guard(false);window.failRestart=true`)
      await click('Restart to update')
      await waitFor(`document.querySelector('[role="alert"]')?.textContent==='Wait for transfers.'`)
      await evaluate(`window.failRestart=false`)
      await click('Restart to update')
      await waitFor(`!!window.rejectRestart`)
      const count = await evaluate(`window.restarts`)
      await click('Restart to update')
      await escape()
      assert.equal(await evaluate(`window.restarts`), count, 'Repeated clicks cannot request another restart')
      assert.equal(await evaluate(`!!document.querySelector('[role="dialog"]')`), true, 'Escape is consumed while restart is pending')
      await evaluate(`window.rejectRestart(Error('Restart canceled for test'))`)
      await waitFor(`document.querySelector('[role="alert"]')?.textContent==='Restart canceled for test'`)
      await escape()
      await waitFor(`!document.querySelector('[role="dialog"]')`)
      await evaluate(`window.unmount()`)
      await waitFor(`window.subscriptions===0`)
      console.log('Update UI passed: automatic availability action, pin deduplication, manual checks, background progress, stale snapshots, cached-draft and transfer guards, explicit restart, duplicate suppression, Escape, focus restoration, and subscription cleanup.')
      window.destroy(); app.exit(0)
    } catch (error) { console.error(error); window.destroy(); app.exit(1) }
  })
}

function fixture() {
  return `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {AppUpdatesDialog} from './src/renderer/src/components/AppUpdatesDialog';
    import {useAppUpdates} from './src/renderer/src/lib/useAppUpdates';
    import {AppUpdateIcon,AppUpdateToolbarAction} from './src/renderer/src/components/AppUpdateToolbarAction';
    import {PinnedToolbarActions} from './src/renderer/src/components/PinnedToolbarActions';
    import {cachedUpdateRestartGuard} from './src/renderer/src/lib/updateRestartGuards';
    window.subscriptions=0;window.checks=0;window.restarts=0;
    window.state={phase:'idle',currentVersion:'0.15.0',version:null,percent:null,stage:'download',message:'Check for signed updates.'};
    window.projectConsole={updates:{get:()=>new Promise(done=>window.resolveInitial=done),
      onChanged:fn=>{window.subscriptions++;window.emit=patch=>{window.state={...window.state,...patch};fn(window.state)};return()=>window.subscriptions--},
      check:async()=>{window.checks++;window.emit({phase:'checking',message:'Checking…'})},
      restart:async()=>{window.restarts++;if(window.failRestart)throw Error('Wait for transfers.');return new Promise((resolve,reject)=>window.rejectRestart=reject)}
    }};window.guard=enabled=>cachedUpdateRestartGuard('fixture',enabled?'Save the cached file first.':null);
    function Fixture(){const updates=useAppUpdates();const [open,setOpen]=useState(false);const [pinned,setPinned]=useState(false);window.pin=setPinned;return <>
      <button id="opener" onClick={()=>setOpen(true)}>Updates</button>
      <PinnedToolbarActions ids={pinned?['app-updates']:[]} actions={[{id:'app-updates',label:'Check for updates…',icon:<AppUpdateIcon state={updates.state}/>,available:true,run:()=>setOpen(true)}]} onReorder={()=>{}}/>
      <AppUpdateToolbarAction state={updates.state} pinned={pinned} onOpen={()=>setOpen(true)}/>
      <AppUpdatesDialog open={open} state={updates.state} onClose={()=>setOpen(false)} onCheck={updates.check} onRestart={updates.restart}/>
    </>};const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();root.render(<Fixture/>);
  `
}
