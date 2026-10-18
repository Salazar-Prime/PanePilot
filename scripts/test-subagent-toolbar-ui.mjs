import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-toolbar-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(temp, 'fixture.js') })
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
  setTimeout(() => { process.stderr.write('Sub-agent toolbar test timed out.\n'); app.exit(1) }, 25_000).unref()
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 700, height: 400, show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const buttons = `document.querySelectorAll('[aria-label="Sub-agents"]').length`
    try {
      await window.loadURL('data:text/html,<html><body><div id="root"></div></body></html>')
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await waitFor(`!!window.updateToolbar`)
      assert.equal(await evaluate(buttons), 0)
      await evaluate(`window.updateToolbar({session:'empty'})`)
      await waitFor(`window.reads.includes('empty')`)
      assert.equal(await evaluate(buttons), 0)
      await evaluate(`window.updateToolbar({session:'with-agents'})`)
      await waitFor(`${buttons}===1`)
      await evaluate(`document.querySelector('[aria-label="Sub-agents"]').click()`)
      assert.equal(await evaluate(`window.opens`), 1)
      await evaluate(`window.updateToolbar({pinned:true})`)
      await waitFor(`document.querySelector('[data-pinned-action="sub-agents"]')`)
      assert.equal(await evaluate(buttons), 1, 'Pinned and automatic actions must not duplicate')
      await evaluate(`window.updateToolbar({session:null})`)
      await waitFor(`document.querySelector('[aria-label="Sub-agents"]').disabled`)
      assert.equal(await evaluate(buttons), 1, 'Pinned button stays visible outside chats')
      await evaluate(`window.updateToolbar({pinned:false})`)
      await waitFor(`${buttons}===0`)
      await evaluate(`window.updateToolbar({session:'late'})`)
      await waitFor(`!!window.resolveLate`)
      await evaluate(`window.updateToolbar({session:'empty'})`)
      await waitFor(`window.reads.at(-1)==='empty'`)
      await evaluate(`window.resolveLate({rootFound:true,count:3,limited:false})`)
      assert.equal(await evaluate(buttons), 0, 'Late response from a previous chat is discarded')
      await evaluate(`window.updateToolbar({session:'with-agents'})`)
      await waitFor(`${buttons}===1`)
      await evaluate(`window.hidden=true;document.dispatchEvent(new Event('visibilitychange'));window.readCount=window.reads.length`)
      await evaluate(`new Promise(done=>setTimeout(done,140))`)
      assert.equal(await evaluate(`window.reads.length===window.readCount`), true)
      await evaluate(`window.hidden=false;window.count=0;document.dispatchEvent(new Event('visibilitychange'))`)
      await waitFor(`${buttons}===0`)
      await evaluate(`window.count=2`)
      await waitFor(`${buttons}===1`)
      await evaluate(`window.fail=true;document.dispatchEvent(new Event('visibilitychange'))`)
      await evaluate(`new Promise(done=>setTimeout(done,100))`)
      assert.equal(await evaluate(buttons), 1, 'Transient archive failures retain known presence')
      await evaluate(`window.updateToolbar({provider:'new-thread'})`)
      await waitFor(`${buttons}===0`)
      await evaluate(`window.unmount();window.readCount=window.reads.length`)
      await evaluate(`new Promise(done=>setTimeout(done,140))`)
      assert.equal(await evaluate(`window.reads.length===window.readCount`), true)
      process.stdout.write('Sub-agent toolbar passed: automatic show/hide, persistent pins, no duplicates, exact thread switches, stale reads, hidden/unmounted polling, and transient failures.\n')
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
    import {AutomaticSubagentAction} from './src/renderer/src/components/AutomaticSubagentAction';
    import {PinnedToolbarActions} from './src/renderer/src/components/PinnedToolbarActions';
    const timeout=window.setTimeout.bind(window);window.setTimeout=(handler,delay,...args)=>timeout(handler,delay===10000?60:delay,...args);
    window.hidden=false;Object.defineProperty(document,'hidden',{get:()=>window.hidden});
    window.reads=[];window.opens=0;window.count=2;
    window.projectConsole={terminals:{subagentSummary:async(id)=>{
      window.reads.push(id);if(id==='late')return new Promise(done=>window.resolveLate=done);
      if(window.fail)throw Error('Offline');return {rootFound:true,count:id==='empty'?0:window.count,limited:false};
    }}};
    const root=createRoot(document.getElementById('root'));let state={session:null,provider:'thread',pinned:false};
    const render=()=>root.render(<div>
      <PinnedToolbarActions ids={state.pinned?['sub-agents']:[]} actions={[{id:'sub-agents',label:'Sub-agents',icon:'Agents',available:!!state.session,run:()=>window.opens++}]} onReorder={()=>{}}/>
      <AutomaticSubagentAction sessionId={state.session} providerSessionId={state.provider} pinned={state.pinned} active={false} onToggle={()=>window.opens++}/>
    </div>);
    window.updateToolbar=(change)=>{state={...state,...change};render()};window.unmount=()=>root.unmount();render();
  `
}
