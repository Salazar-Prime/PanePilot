import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-notes-draft-cache-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'isolated-notes-fixture', setup(builder) {
        builder.onResolve({ filter: /\/lib\/monaco$/ }, () => ({ path: 'editor', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: root, contents: `
          import React,{useEffect} from 'react';export const monaco={KeyMod:{CtrlCmd:1},KeyCode:{KeyS:1}};export function discardEditorDraft(){}export function forgetEditorModel(){}
          export function Editor({value,onChange,onMount}){useEffect(()=>{onMount({addCommand(){},addAction:()=>({dispose(){}}),focus(){}})},[]);return <textarea aria-label="Source editor" value={value} onChange={e=>onChange(e.target.value)}/>;}
        ` }))
      } }] })
    await writeFile(join(temp, 'index.html'), '<html><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => { const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' }); child.once('error', reject); child.once('exit', done) })
    if (code !== 0) process.exitCode = 1
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  setTimeout(() => { process.stderr.write('Notes draft cache test timed out.\n'); app.exit(1) }, 30_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => { for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await new Promise((done) => setTimeout(done, 20)) }; throw new Error(`UI did not settle: ${code}`) }
    const click = (label) => evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(label)}).click()`)
    const type = (value) => evaluate(`{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))}`)
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor('document.querySelector(".markdown-body")?.textContent.includes("Saved first")')
      await click('Source'); await waitFor('!!document.querySelector("textarea")'); await type('Unsaved note survives')
      await click('Preview'); await waitFor('document.querySelector(".markdown-body")?.textContent.includes("Unsaved note survives")')
      await evaluate('window.change({mounted:false})'); await waitFor('!document.querySelector(".notes-panel")')
      assert.match(await evaluate('window.blocker()'), /project note/)
      await evaluate('window.change({projectId:"other",mounted:true})'); await waitFor('document.querySelector(".markdown-body")?.textContent.includes("Saved first")')
      await evaluate('window.change({projectId:"paper"})'); await waitFor('document.querySelector(".markdown-body")?.textContent.includes("Unsaved note survives")')
      assert.equal(await evaluate('document.querySelector("textarea")===null'), true)
      await click('Source'); await waitFor('document.querySelector("textarea")?.value==="Unsaved note survives"')
      await evaluate('window.failSave=true'); await click('Save'); await waitFor('document.querySelector(".notes-error")?.textContent.includes("fixture save failure")')
      assert.equal(await evaluate('document.querySelector("textarea").value'), 'Unsaved note survives')
      await evaluate('window.failSave=false'); await click('Save'); await waitFor('window.saves.length===1 && !document.querySelector(".notes-dirty")')
      assert.equal(await evaluate('window.blocker()'), null)
      await type('Discard me'); await evaluate('window.confirm=()=>true;document.querySelectorAll(".notes-list-scroll button")[1].click()')
      await waitFor('document.querySelector(".notes-header strong")?.textContent==="Second"')
      await evaluate('document.querySelectorAll(".notes-list-scroll button")[0].click()')
      await waitFor('document.querySelector("textarea")?.value==="Unsaved note survives"')
      assert.equal(await evaluate('window.blocker()'), null)
      process.stdout.write('Notes draft cache passed: Preview/Source remount, project switch, update guard, failed save retry, exact save, and explicit discard.\n')
      app.exit(0)
    } catch (error) { console.error(error); app.exit(1) }
  })
}

function fixture() { return `
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{NotesPanel}from'./src/renderer/src/components/NotesPanel';
import{updateRestartBlocker}from'./src/renderer/src/lib/updateRestartGuards';
window.blocker=updateRestartBlocker;window.saves=[];window.failSave=false;const saved=new Map();
const note=(project,path)=>({path,name:path==='first.md'?'First':'Second',content:saved.get(project+path)??('Saved '+(path==='first.md'?'first':'second')),updatedAt:'2026-01-01'});
window.projectConsole={notes:{list:async(project)=>['first.md','second.md'].map(path=>note(project,path)),read:async(project,path)=>note(project,path),write:async(project,path,content)=>{if(window.failSave)throw Error('fixture save failure');window.saves.push({project,path,content});saved.set(project+path,content);return note(project,path)}},files:{preview:async()=>{throw Error('unexpected file read')}},system:{}};
function App(){const[state,setState]=useState({projectId:'paper',mounted:true});window.change=patch=>setState(current=>({...current,...patch}));return state.mounted?<NotesPanel project={{id:state.projectId,name:state.projectId,connectionId:'local'}}/>:null}createRoot(document.getElementById('root')).render(<App/>);
` }
