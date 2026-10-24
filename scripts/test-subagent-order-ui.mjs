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
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-agent-order-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      loader: { '.css': 'empty' }, outfile: join(temp, 'fixture.js') })
    const css = await readFile(join(root, 'src/renderer/src/subagents.css'), 'utf8')
    const xtermCss = await readFile(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${css}${xtermCss}body{font-family:system-ui}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
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
  setTimeout(() => { process.stderr.write('Sub-agent ordering test timed out.\n'); app.exit(1) }, 25_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1400, height: 820, show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const order = () => evaluate(`Array.from(document.querySelectorAll('.subagent-window-heading strong'),e=>e.textContent)`)
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor(`document.querySelectorAll('.subagent-window .xterm').length===5`)
      assert.deepEqual(await order(), ['Eta', 'Zeta', 'Delta', 'Alpha', 'Beta'])
      await evaluate(`void(window.terminalNode=document.querySelector('[aria-label="Zeta terminal output"] .xterm'))`)
      await evaluate(`window.agents[1].state='finished'`)
      await waitFor(`document.querySelectorAll('.subagent-window-heading strong')[4]?.textContent==='Zeta'`)
      assert.equal(await evaluate(`window.terminalNode===document.querySelector('[aria-label="Zeta terminal output"] .xterm')`), true,
        'A status-driven move retains the same terminal surface')
      await evaluate(`window.agents[1].state='working'`)
      await waitFor(`document.querySelectorAll('.subagent-window-heading strong')[1]?.textContent==='Zeta'`)
      await evaluate(`window.agents[1].updatedAt='2099-01-01';window.agents[1].output.push({kind:'message',text:'More output',timestamp:null});window.beforeReads=window.reads`)
      await waitFor(`window.reads>window.beforeReads`)
      assert.deepEqual(await order(), ['Eta', 'Zeta', 'Delta', 'Alpha', 'Beta'])
      await evaluate(`window.agents=Array.from({length:12},(_,i)=>window.makeAgent(i<9?'A'+i:'Z'+i,i<9?'finished':'working'))`)
      await waitFor(`document.querySelectorAll('.subagent-window .xterm').length===8`)
      assert.deepEqual((await order()).slice(0, 3), ['Z9', 'Z10', 'Z11'])
      await evaluate(`document.querySelector('[aria-label="Next eight agents"]').click()`)
      await waitFor(`document.querySelectorAll('.subagent-window').length===4`)
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('.subagent-state')).every(e=>e.classList.contains('finished'))`), true)
      await evaluate(`document.querySelector('[aria-label="Previous eight agents"]').click()`)
      await waitFor(`document.querySelector('.subagent-window-heading strong')?.textContent==='Z9'`)
      await evaluate(`document.querySelector('[aria-label="Close sub-agents"]').click()`)
      await waitFor(`!document.querySelector('.subagent-glass')`)
      await evaluate(`window.beforeReads=window.reads`)
      await evaluate(`new Promise(done=>setTimeout(done,160))`)
      assert.equal(await evaluate(`window.reads===window.beforeReads`), true)
      assert.deepEqual(await evaluate(`window.errors`), [])
      process.stdout.write('Sub-agent ordering passed: active first, terminal states last, stable output updates, retained xterm surfaces, full-list paging, and cleanup.\n')
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
    import {SubagentOverlay} from './src/renderer/src/components/SubagentOverlay';
    const timeout=window.setTimeout.bind(window);window.setTimeout=(fn,delay,...args)=>timeout(fn,delay===3000?60:delay,...args);
    window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));
    Object.defineProperty(document,'hidden',{get:()=>false});
    window.makeAgent=(name,state)=>({id:name,parentId:'root',name,path:'/root/'+name,state,updatedAt:'2026-10-24',output:[{kind:'message',text:'Saved output',timestamp:null}],truncated:false});
    window.agents=[window.makeAgent('Alpha','finished'),window.makeAgent('Zeta','working'),window.makeAgent('Beta','stopped'),window.makeAgent('Delta','unknown'),window.makeAgent('Eta','working')];
    window.reads=0;window.projectConsole={terminals:{subagents:async()=>{window.reads++;return structuredClone({agents:window.agents,total:window.agents.length,limited:false,rootFound:true})}}};
    const root=createRoot(document.getElementById('root'));
    root.render(<SubagentOverlay sessionId="fixture" sessionName="Chat" projectName="Project" onClose={()=>root.render(null)}/>);
  `
}
