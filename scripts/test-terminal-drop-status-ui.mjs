import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-transfer-status-ui-'))
  try {
    const source = await readFile(join(root, 'src/renderer/src/components/App.tsx'), 'utf8')
    assert.ok(source.includes('<div id="status-transfer-actions" className="status-brand">'), 'App owns the left transfer action slot')
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js') })
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
  setTimeout(() => { process.stderr.write('Transfer status test timed out.\n'); app.exit(1) }, 25_000).unref()
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1600, height: 500, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const copy = `document.querySelector('[aria-label="Copy transferred file paths"]')`
    const emit = async (event) => evaluate(`window.emit(${JSON.stringify(event)})`)
    const event = { id: 'upload', sessionId: 'terminal', projectId: 'project', operation: 'upload',
      target: 'mockingBeat:/project', fileName: 'screen shot.png', state: 'uploading', paths: [],
      completedFiles: 0, totalFiles: 2, transferredBytes: 128, totalBytes: 1024, updatedAt: 2 }
    const path = "/project/.panepilot/dropped-assets/id/screen shot.png"
    try {
      await window.loadURL('data:text/html,<html><body><div id="root"></div></body></html>')
      await window.webContents.insertCSS(await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8'))
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await waitFor(`!!window.emit && window.subscriptions===1`)
      assert.equal(await evaluate(`!!${copy}`), false, 'No successful paths means no copy button')
      await emit(event)
      await waitFor(`!!document.querySelector('progress')`)
      assert.equal(await evaluate(`!!${copy}`), false)
      await emit({ ...event, paths: [path], completedFiles: 1, transferredBytes: 512, updatedAt: 3 })
      await waitFor(`!!${copy}`)
      assert.equal(await evaluate(`${copy}.parentElement.id`), 'status-transfer-actions')
      assert.equal(await evaluate(`document.querySelectorAll('.status-right .terminal-drop-copy').length`), 0)
      await evaluate(`window.resolveInitial([{...${JSON.stringify(event)},updatedAt:1}])`)
      await evaluate(`new Promise(done=>setTimeout(done,30))`)
      assert.equal(await evaluate(`!!${copy}`), true, 'Older initial snapshot cannot replace live progress')
      await evaluate(`${copy}.click()`)
      await waitFor(`${copy}.textContent==='Copied'`)
      assert.equal(await evaluate(`window.copied.at(-1)`), `'${path}' `)

      await evaluate(`window.setYolo(false)`)
      await waitFor(`!document.querySelector('.status-unsafe')`)
      assert.equal(await evaluate(`!!${copy}`), true, 'Copy stays available outside YOLO sessions')
      await evaluate(`window.setYolo(true)`)
      await waitFor(`!!document.querySelector('.status-unsafe')`)
      for (const width of [1600, 1120, 900]) {
        window.setContentSize(width, 500)
        await evaluate(`new Promise(requestAnimationFrame)`)
        const layout = await evaluate(`(() => {
          const rect=selector=>document.querySelector(selector).getBoundingClientRect();
          const bar=rect('.status-bar'),pill=rect('.status-unsafe'),copy=rect('.terminal-drop-copy');
          const nav=rect('.status-workspace-nav'),right=rect('.status-right');
          return {height:bar.height,copyLeft:copy.left,pillRight:pill.right,copyRight:copy.right,
            navLeft:nav.left,navRight:nav.right,navCenter:(nav.left+nav.right)/2,rightLeft:right.left,
            center:bar.width/2,overflow:document.documentElement.scrollWidth>innerWidth};
        })()`)
        assert.equal(layout.height, 26, 'Status bar height stays fixed')
        assert.ok(layout.copyLeft >= layout.pillRight && layout.copyLeft - layout.pillRight <= 8, 'Copy is beside YOLO, including after toggling it')
        assert.ok(layout.copyRight <= layout.navLeft && layout.navRight <= layout.rightLeft, `Status regions do not overlap at ${width}px`)
        assert.equal(layout.overflow, false)
        if (width > 1080) assert.ok(Math.abs(layout.navCenter - layout.center) < 1, 'Workspace tools stay centered')
      }

      await emit({ ...event, paths: [path], completedFiles: 1, state: 'failed', error: 'Connection lost', updatedAt: 4 })
      await waitFor(`!!document.querySelector('.terminal-drop-status.failed')`)
      await evaluate(`window.failCopy=true;${copy}.click()`)
      await waitFor(`document.querySelector('[role="alert"]')?.textContent.includes('Clipboard unavailable')`)
      await evaluate(`window.failCopy=false;${copy}.click()`)
      await waitFor(`!document.querySelector('[role="alert"]')`)
      assert.equal(await evaluate(`window.copied.at(-1)`), `'${path}' `, 'Partial failure keeps successful remote paths copyable')
      await evaluate(`document.querySelector('[aria-label="Dismiss transfer status"]').click()`)
      await waitFor(`!${copy} && !document.querySelector('.terminal-drop-status')`)

      await emit({ ...event, id: 'next', paths: ['/project/new.txt'], completedFiles: 2, state: 'completed', updatedAt: 5 })
      await waitFor(`${copy}?.textContent==='Copy paths'`)
      await evaluate(`${copy}.click()`)
      await waitFor(`${copy}.textContent==='Copied'`)
      assert.equal(await evaluate(`window.copied.at(-1)`), "'/project/new.txt' ")
      assert.equal(await evaluate(`window.subscriptions`), 1, 'Both regions share a single progress subscription')
      if (process.env.PANEPILOT_UI_SCREENSHOT) {
        window.setContentSize(1600, 500)
        await evaluate(`new Promise(requestAnimationFrame)`)
        const { writeFile } = await import('node:fs/promises')
        await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      }
      await evaluate(`window.unmount()`)
      await waitFor(`window.subscriptions===0`)
      process.stdout.write('Transfer status passed: left copy action, YOLO toggle, fixed height/centered tools, live snapshots, clipboard feedback/errors, partial failures, dismissal, and subscription cleanup.\n')
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
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {ShieldAlert} from 'lucide-react';
    import {TerminalDropStatus} from './src/renderer/src/components/TerminalDropStatus';
    window.subscriptions=0;window.copied=[];
    window.projectConsole={terminalDrops:{
      onProgress:fn=>{window.emit=fn;window.subscriptions++;return()=>window.subscriptions--},
      list:()=>new Promise(done=>window.resolveInitial=done)
    },system:{copyText:async(text)=>{if(window.failCopy)throw Error('Clipboard unavailable');window.copied.push(text)}}};
    function Fixture(){const [yolo,setYolo]=useState(true);window.setYolo=setYolo;
      return <div className="app-shell"><footer className="status-bar">
        <div id="status-transfer-actions" className="status-brand">
          {yolo&&<span className="status-unsafe"><ShieldAlert size={11}/>YOLO agent</span>}
        </div>
        <div className="status-workspace-nav"><div className="workspace-tabs">
          {['Terminals','Actions','Notes','Files','LLM Chats','Activity'].map(name=><button key={name}>{name}</button>)}
        </div></div>
        <div className="status-right"><TerminalDropStatus/><div className="status-summary"><span>0 working</span></div></div>
      </footer></div>}
    const root=createRoot(document.getElementById('root'));window.unmount=()=>root.unmount();root.render(<Fixture/>);
  `
}
