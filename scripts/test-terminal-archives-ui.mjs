// Isolated production archive controls with synthetic records and IPC only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-terminal-archives-ui-'))
  try {
    const { build } = await import('esbuild')
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root }, bundle: true,
      platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@shared': join(root, 'src/shared') },
      outfile: join(temp, 'fixture.js') })
    const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><meta charset="utf-8"><style>${css}body{padding:24px}#bar{width:850px}.terminal-tabs-scroll{height:38px}.terminal-tab-select{padding:10px}.terminal-tabs{margin-top:16px}</style><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
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
    const window = new BrowserWindow({ width: 1100, height: 760, show: false, webPreferences: { sandbox: true, backgroundThrottling: false } })
    const evaluate = async (code) => {
      try { return await window.webContents.executeJavaScript(code) }
      catch (cause) { console.error('Fixture expression:', code); throw cause }
    }
    const pause = (ms = 30) => new Promise((done) => setTimeout(done, ms))
    const waitFor = async (code) => { for (let attempt = 0; attempt < 150; attempt++) { if (await evaluate(code)) return; await pause(20) }; throw Error(`Archive UI did not settle: ${code}`) }
    const button = 'document.querySelector(".terminal-archive-shortcut")'
    const modal = 'document.querySelector(".terminal-archives-modal")'
    const errors = []
    window.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor(`${button} && !${button}.hidden`)
      assert.equal(await evaluate('document.querySelector(".terminal-tabs").getBoundingClientRect().height'), 39, 'Archive keeps the ordinary tab bar height.')
      await evaluate('window.setBarWidth(120)')
      await waitFor(`${button}.hidden`)
      assert.equal(await evaluate('document.querySelector(".terminal-tabs-scroll").getBoundingClientRect().width'), 120, 'A hidden archive shortcut reserves no width.')
      await evaluate('window.setBarWidth(850)')
      await waitFor(`!${button}.hidden`)
      await evaluate('window.longTitles(true)')
      await waitFor(`${button}.hidden`)
      await evaluate('window.longTitles(false)')
      await waitFor(`!${button}.hidden`)
      await evaluate('document.getElementById("open").focus();document.getElementById("open").click()')
      await waitFor(`${modal} && document.activeElement.getAttribute('aria-label')==='Find archived terminals'`)
      assert.equal(await evaluate('document.querySelectorAll(".terminal-archive-row").length'), 2, 'Only archived ordinary terminals from this project appear.')
      assert.equal(await evaluate(`${modal}.querySelector('h2 small').textContent`), '2')
      await evaluate(`window.query('Codex')`)
      await waitFor('document.querySelectorAll(".terminal-archive-row").length===1')
      assert.equal(await evaluate('document.querySelector(".terminal-archive-row strong").textContent'), 'Codex plan')
      await evaluate(`window.query('')`)
      await waitFor('document.querySelectorAll(".terminal-archive-row").length===2')
      await evaluate(`document.querySelector('[aria-label="Restore Codex plan"]').click();document.querySelector('[aria-label="Restore Codex plan"]').click()`)
      await waitFor('window.calls.length===1')
      await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
      assert.equal(await evaluate(`!!${modal}`), true, 'Escape cannot dismiss an in-flight archive operation.')
      await evaluate('window.failRestore()')
      await waitFor(`${modal}.querySelector('[role="alert"]')?.textContent==='SSH offline'`)
      await pause(100); assert.equal(await evaluate('window.calls.length'), 1, 'Failed restore does not loop or silently remove the record.')
      await evaluate(`document.querySelector('[aria-label="Restore Codex plan"]').click()`)
      await waitFor('window.calls.length===2'); await evaluate('window.finishRestore()')
      await waitFor('document.querySelectorAll(".terminal-archive-row").length===1')
      await evaluate(`window.confirmDelete=false;document.querySelector('[aria-label="Delete archived Build logs"]').click()`)
      assert.equal(await evaluate('window.deleted.length'), 0, 'Delete needs explicit confirmation.')
      await evaluate(`window.confirmDelete=true;document.querySelector('[aria-label="Delete archived Build logs"]').click()`)
      await waitFor('!!document.querySelector(".terminal-archives-empty")')
      assert.deepEqual(await evaluate('window.deleted'), ['p:logs'])
      await evaluate('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
      await waitFor(`!${modal}`)
      assert.equal(await evaluate('document.activeElement.id'), 'open', 'Dismissal restores opener focus.')
      await evaluate('window.otherProject()')
      await waitFor(`${modal} && document.querySelector('.terminal-archive-row strong')?.textContent==='Remote terminal'`)
      assert.equal(await evaluate(`${modal}.querySelector('header p').textContent`), 'Remote project')
      await evaluate(`document.querySelector('[aria-label="Delete archived Remote terminal"]').focus()`)
      await evaluate(`${modal}.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}))`)
      assert.equal(await evaluate('document.activeElement.getAttribute("aria-label")'), 'Close terminal archive', 'Tab stays inside the archive dialog.')
      assert.deepEqual(errors, [])
      assert.deepEqual(await evaluate('window.errors'), [])
      if (process.env.PANEPILOT_UI_SCREENSHOT) await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      process.stdout.write('Terminal archives UI passed: spare-space shortcut, no width reservation when crowded, long-title protection, project scoping, filtering, restore failure/duplicate guards, confirmed delete, busy Escape, focus trap and focus restoration.\n')
      window.destroy(); app.exit(0)
    } catch (cause) {
      process.stderr.write(`${cause.stack ?? cause}\n`)
      console.error(await evaluate(`({bar:document.getElementById('bar')?.outerHTML, widths:[...document.querySelectorAll('.terminal-tabs,.terminal-tabs-scroll,.terminal-tab')].map(e=>({class:e.className,width:e.clientWidth,scroll:e.scrollWidth,rect:e.getBoundingClientRect().width})),errors:window.errors})`).catch(() => null))
      window.destroy(); app.exit(1)
    }
  })
}

function fixture() {
  return `import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';
    import{TerminalArchiveButton}from'./src/renderer/src/components/TerminalArchiveButton';
    import{ArchivedTerminalsDialog}from'./src/renderer/src/components/ArchivedTerminalsDialog';
    const session=(projectId,id,name,profile='shell',kind='terminal',archived=true)=>({id:projectId+':'+id,projectId,name,profile,kind,archived,updatedAt:'2026-11-01T12:00:00Z',state:'completed',providerSessionId:profile==='codex'?'synthetic-provider-id':null});
    const projects={p:{id:'p',name:'Local project',sessions:[session('p','logs','Build logs'),session('p','codex','Codex plan','codex'),session('p','live','Live', 'shell','terminal',false),session('p','action','Hidden action','shell','action'),session('q','foreign','Foreign')]},q:{id:'q',name:'Remote project',sessions:[session('q','remote','Remote terminal')]}};
    window.calls=[];window.deleted=[];window.errors=[];window.confirmDelete=false;window.confirm=()=>window.confirmDelete;
    addEventListener('error',e=>window.errors.push(e.message));let setWidth,setLong,setOpen,setProject,refresh;
    function Fixture(){const[width,widthState]=useState(850),[long,longState]=useState(false),[open,openState]=useState(false),[project,projectState]=useState('p'),[revision,revisionState]=useState(0);const strip=useRef(null);setWidth=widthState;setLong=longState;setOpen=openState;setProject=projectState;refresh=()=>revisionState(n=>n+1);
      return <><button id="open" onClick={()=>openState(true)}>Archived terminals</button><div className="terminal-tabs" id="bar" style={{width}}><div className="terminal-tabs-scroll" ref={strip}>{[long?'A terminal name that is deliberately far wider than the available toolbar space '.repeat(4):'Current shell'].map(name=><div className="terminal-tab active" key={name}><button className="terminal-tab-select"><span>{name}</span></button></div>)}</div><TerminalArchiveButton strip={strip} revision={String(long)+revision} count={2} onClick={()=>openState(true)}/></div>
      {open&&<ArchivedTerminalsDialog key={project} project={projects[project]} onClose={()=>openState(false)} onRestore={async s=>{window.calls.push(s.id);await new Promise((resolve,reject)=>{window.finishRestore=()=>{s.archived=false;refresh();resolve()};window.failRestore=()=>reject(Error('SSH offline'))})}} onDelete={async s=>{window.deleted.push(s.id);projects[s.projectId].sessions=projects[s.projectId].sessions.filter(other=>other.id!==s.id);refresh()}}/>}</>}
    window.setBarWidth=n=>setWidth(n);window.longTitles=value=>setLong(value);window.otherProject=()=>{setProject('q');setOpen(true)};
    window.query=value=>{const input=document.querySelector('[aria-label="Find archived terminals"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true}))};
    createRoot(document.getElementById('root')).render(<Fixture/>);`
}
