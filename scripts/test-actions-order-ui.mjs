import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-action-order-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'no-live-terminal', setup(builder) {
        builder.onResolve({ filter: /^\.\/ManagedTerminal$/ }, () => ({ path: 'terminal', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: root, contents:
          'export function ManagedTerminal(){return <div data-terminal="stub">Existing action output</div>}' }))
      } }] })
    const styles = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${styles}
      html,body,#root{height:100%;margin:0}#primary{height:100%;display:flex}#mirror{display:none}
      </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', done)
    })
    if (code !== 0) process.exitCode = 1
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  setTimeout(() => { process.stderr.write('Actions ordering test timed out.\n'); app.exit(1) }, 45_000).unref()
  void app.whenReady().then(async () => {
    // A component fixture only: no app entry, user database, visible window, or live terminals.
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1040, height: 500, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const pause = (ms = 30) => new Promise((done) => setTimeout(done, ms))
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await pause(20)
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const ids = (scope = '#primary') => evaluate(`Array.from(document.querySelectorAll('${scope} [data-action-id]'),e=>e.dataset.actionId)`)
    const saved = () => evaluate(`JSON.parse(localStorage.getItem('panepilot.action-order.v1:project'))`)
    const point = (id) => evaluate(`(()=>{const r=document.querySelector('#primary [data-action-id="${id}"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()`)
    const send = (type, p) => window.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: 1 })
    const begin = async (id) => {
      const p = await point(id)
      send('mouseMove', p)
      send('mouseDown', p)
      await pause()
      return p
    }
    const move = async (p) => { send('mouseMove', p); await pause(40) }
    const end = async (p) => { send('mouseUp', p); await pause(50) }
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor(`!!window.updateActions && document.querySelectorAll('#primary [data-action-id]').length===12`)
      assert.deepEqual(await ids(), Array.from({ length: 12 }, (_, i) => `a${i + 1}`))
      await evaluate(`void(window.outputNode=document.querySelector('[data-terminal]'))`)
      assert.equal(await evaluate(`document.querySelector('#primary .action-runner-heading').textContent.includes('Stop')`), true)

      await begin('a2')
      let target = await point('a4')
      target.y += 8
      await move(target)
      await waitFor(`document.querySelector('#primary [data-action-id="a2"]').classList.contains('dragging')`)
      if (process.env.PANEPILOT_UI_SCREENSHOT) {
        const image = await window.webContents.capturePage()
        await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, image.toPNG())
      }
      assert.equal(await saved(), null, 'A preview must not persist before drop')
      await end(target)
      assert.deepEqual((await ids()).slice(0, 5), ['a1', 'a3', 'a4', 'a2', 'a5'])
      assert.deepEqual(await saved(), await ids())
      assert.deepEqual(await ids('#mirror'), await ids(), 'Both split panes synchronize')
      assert.equal(await evaluate(`document.querySelector('#primary button.active').dataset.actionId`), 'a1', 'Drag must not select')
      assert.equal(await evaluate(`window.outputNode===document.querySelector('[data-terminal]')`), true, 'Output stays mounted')
      assert.deepEqual(await evaluate(`window.calls`), { run: 0, stop: 0, delete: 0 })

      // Remount and independent project preference.
      await evaluate(`window.updateActions({mounted:false})`)
      await waitFor(`!document.querySelector('#primary')`)
      await evaluate(`window.updateActions({mounted:true})`)
      await waitFor(`document.querySelector('#primary [data-action-id]')?.dataset.actionId==='a1'`)
      assert.deepEqual(await ids(), await saved())
      await evaluate(`window.updateActions({projectId:'other-project'})`)
      await waitFor(`document.querySelectorAll('#primary [data-action-id]')[1]?.dataset.actionId==='a2'`)
      await evaluate(`window.updateActions({projectId:'project'})`)
      await waitFor(`document.querySelectorAll('#primary [data-action-id]')[1]?.dataset.actionId==='a3'`)

      // Small movements are still clicks, not rearrangement or execution.
      const order = await saved()
      const start = await begin('a3')
      await move({ x: start.x, y: start.y + 2 })
      await end({ x: start.x, y: start.y + 2 })
      await waitFor(`document.querySelector('#primary button.active').dataset.actionId==='a3'`)
      assert.deepEqual(await saved(), order)

      // Escape cancels preview and consumes the release click.
      await begin('a2')
      target = await point('a1')
      await move(target)
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
      await end(target)
      assert.deepEqual(await ids(), order)
      assert.deepEqual(await saved(), order)
      assert.equal(await evaluate(`document.querySelector('#primary button.active').dataset.actionId`), 'a3')

      for (const cancel of ['blur', 'pointercancel', 'outside', 'hidden']) {
        await begin('a2')
        target = await point('a1')
        await move(target)
        if (cancel === 'outside') target = { x: 600, y: target.y }
        else if (cancel === 'pointercancel') await evaluate(`(()=>{const e=document.querySelector('.dragging');e.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.lastPointer,bubbles:true}))})()`)
        else if (cancel === 'hidden') await evaluate(`window.fixtureHidden=true;document.dispatchEvent(new Event('visibilitychange'))`)
        else await evaluate(`window.dispatchEvent(new Event('blur'))`)
        await end(target)
        await evaluate(`window.fixtureHidden=false`)
        assert.deepEqual(await ids(), order, `${cancel} cancels the drag`)
        assert.deepEqual(await saved(), order)
      }

      // Live status refresh must leave a drag intact; a shared definition change cancels it.
      await begin('a2')
      target = await point('a1')
      await move(target)
      await evaluate(`window.updateActions({refresh:1})`)
      await waitFor(`!!document.querySelector('.dragging')`)
      await evaluate(`window.updateActions({extra:true})`)
      await waitFor(`!document.querySelector('.dragging') && document.querySelectorAll('#primary [data-action-id]').length===13`)
      await end(target)
      assert.deepEqual((await ids()).slice(0, 12), order)
      assert.equal((await ids()).at(-1), 'a13')
      assert.deepEqual(await saved(), order)

      // Repeated keyboard moves preserve selection and keep the focused row.
      await evaluate(`(()=>{const b=document.querySelector('#primary [data-action-id="a2"]');b.focus();b.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',altKey:true,bubbles:true}))})()`)
      await waitFor(`document.querySelectorAll('#primary [data-action-id]')[2]?.dataset.actionId==='a2'`)
      assert.deepEqual(await saved(), await ids())
      assert.equal(await evaluate(`document.querySelector('#primary button.active').dataset.actionId`), 'a3')
      assert.equal(await evaluate(`document.activeElement.dataset.actionId`), 'a2', 'Keyboard reorder keeps focus')

      // Dragging at the bottom edge scrolls a long list without another pointer move.
      await evaluate(`document.querySelector('#primary .actions-list-scroll').scrollTop=0`)
      await pause(250)
      await begin('a1')
      target = await evaluate(`(()=>{const r=document.querySelector('#primary .actions-list-scroll').getBoundingClientRect();return {x:Math.round(r.left+80),y:Math.floor(r.bottom-4)}})()`)
      await move(target)
      await waitFor(`document.querySelector('#primary .actions-list-scroll').scrollTop>100`)
      await pause(350)
      await end(target)
      assert.equal((await ids()).at(-1), 'a1', 'Autoscroll permits a drop at the end')
      assert.deepEqual(await saved(), await ids())

      // Remote-window preference changes and clears are reflected without mutating actions.
      await evaluate(`localStorage.setItem('panepilot.action-order.v1:project',JSON.stringify(['a5','a4']));window.dispatchEvent(new StorageEvent('storage',{key:'panepilot.action-order.v1:project'}))`)
      await waitFor(`document.querySelector('#primary [data-action-id]').dataset.actionId==='a5'`)
      await evaluate(`localStorage.clear();window.dispatchEvent(new StorageEvent('storage',{key:null}))`)
      await waitFor(`document.querySelectorAll('#primary [data-action-id]')[1]?.dataset.actionId==='a2'`)

      // Reduced motion and unmount cleanup.
      window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
      assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true)
      await evaluate(`document.querySelector('#primary .actions-list-scroll').scrollTop=0`)
      await pause(250)
      await begin('a1')
      target = await point('a4')
      await move(target)
      await end(target)
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('#primary [data-action-id], #primary .action-sort-icon > svg')).reduce((count,item)=>count+item.getAnimations().length,0)`), 0,
        'Reduced motion disables reordering motion, without changing the existing running-status indicator')
      const lastSaved = await saved()
      await begin('a2')
      target = await point('a4')
      await move(target)
      await evaluate(`window.updateActions({mounted:false})`)
      await waitFor(`!document.querySelector('#primary')`)
      await end(target)
      assert.deepEqual(await saved(), lastSaved, 'Unmount cannot commit an unfinished drag')
      assert.deepEqual(await evaluate(`window.calls`), { run: 0, stop: 0, delete: 0 })
      assert.deepEqual(await evaluate(`window.errors`), [])
      process.stdout.write('Actions ordering passed: pointer drag, persistence, split synchronization, click safety, stable output, cancellation, live refresh, keyboard ordering, edge scrolling, reduced motion, and cleanup.\n')
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
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {ActionsPanel} from './src/renderer/src/components/ActionsPanel';
    import {SortableActionsList} from './src/renderer/src/components/SortableActionsList';
    window.calls={run:0,stop:0,delete:0};window.errors=[];
    window.addEventListener('error',e=>window.errors.push(e.message));
    window.addEventListener('pointerdown',e=>window.lastPointer=e.pointerId);
    window.fixtureHidden=false;Object.defineProperty(document,'hidden',{get:()=>window.fixtureHidden});
    window.projectConsole={actions:{sync:async()=>{},run:async()=>window.calls.run++,stop:async()=>window.calls.stop++,delete:async()=>window.calls.delete++}};
    const root=createRoot(document.getElementById('root'));
    let state={projectId:'project',mounted:true,extra:false,refresh:0};
    const actions=Array.from({length:13},(_,i)=>({id:'a'+(i+1),name:['Build','Test','Deploy','Lint','Preview','Typecheck','Publish','Clean','Format','Watch','Inspect','Package','Audit'][i],command:'npm run '+['build','test','deploy','lint','preview','typecheck','publish','clean','format','watch','inspect','package','audit'][i],lastSessionId:i===0?'run1':null}));
    const render=()=>{const project={id:state.projectId,folder:'/fixture',actions:actions.slice(0,state.extra?13:12).map(a=>({...a})),sessions:[{id:'run1',state:'running',name:'Build',updatedAt:String(state.refresh)}]};
      root.render(state.mounted?<><main id="primary"><ActionsPanel key={state.projectId} project={project} onChanged={async()=>{}}/></main><aside id="mirror"><SortableActionsList key={state.projectId} projectId={state.projectId} actions={project.actions} sessions={project.sessions} selectedId={null} onSelect={()=>{}}/></aside></>:null)};
    window.updateActions=change=>{state={...state,...change};render()};render();
  `
}
