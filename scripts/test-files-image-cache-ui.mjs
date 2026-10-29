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
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-files-image-cache-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'isolated-files-fixture', setup(builder) {
        builder.onResolve({ filter: /\/lib\/monaco$/ }, () => ({ path: 'editor', namespace: 'fixture' }))
        builder.onResolve({ filter: /\/lib\/filesWorkspaceCache$/ }, () => ({ path: 'cache', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'tsx', resolveDir: root, contents: path === 'cache' ? `
          import {FilesWorkspaceCache as Actual} from ${JSON.stringify(join(root, 'src/renderer/src/lib/filesWorkspaceCache.ts'))};
          export {restoreEvictedPreview} from ${JSON.stringify(join(root, 'src/renderer/src/lib/filesWorkspaceCache.ts'))};
          export class FilesWorkspaceCache extends Actual {constructor(){super(32)}};
        ` : `
          import React,{useEffect} from 'react';export const monaco={};export function discardEditorDraft(){}export function forgetEditorModel(){}
          export function Editor({value,onChange,onMount,options}){
            useEffect(()=>{onMount({addAction:()=>({dispose(){}}),setPosition(){},revealPositionInCenter(){},focus(){}})},[]);
            return <textarea aria-label="Source editor" value={value} readOnly={options.readOnly} onChange={e=>onChange(e.target.value)}/>;
          }
        ` }))
      } }] })
    await writeFile(join(temp, 'index.html'), '<html><body><div id="root"></div><script src="fixture.js"></script></body></html>')
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
  setTimeout(() => { process.stderr.write('Files image cache test timed out.\n'); app.exit(1) }, 30_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1200, height: 760, show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const tab = (path) => `document.querySelector('[data-file-path="${path}"]')`
    const clickText = (text) => evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`)
    const open = async (path) => {
      await evaluate(`Array.from(document.querySelectorAll('.file-row')).find(e=>e.querySelector('span')?.textContent===${JSON.stringify(path)}).click()`)
      await waitFor(`${tab(path)}?.classList.contains('selected')`)
    }
    const unmount = async () => { await evaluate('window.changeFiles({mounted:false})'); await waitFor('!document.querySelector(".files-layout")') }
    const remount = async () => { await evaluate('window.changeFiles({mounted:true})'); await waitFor('!!document.querySelector(".files-layout")') }
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor('!!document.querySelector(".file-row")')
      await open('image.png')
      await waitFor('!!document.querySelector(".file-image-preview img")')
      await evaluate(`${tab('image.png')}.querySelector('[role="tab"]').click()`)
      await unmount()
      await evaluate('window.deferImage=true')
      await remount()
      await waitFor('document.querySelector(".preview-empty")?.textContent.includes("Loading image preview") && !!window.pendingImage')
      assert.equal(await evaluate(`${tab('image.png')}.classList.contains('temporary')`), false)
      await open('draft.txt')
      await evaluate('window.resolveImage()')
      await evaluate('new Promise(done=>setTimeout(done,30))')
      assert.equal(await evaluate(`${tab('draft.txt')}.classList.contains('selected')`), true, 'A late image does not steal selection')
      await clickText('Edit')
      await evaluate(`{const e=document.querySelector('[aria-label="Source editor"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Unsaved draft');e.dispatchEvent(new Event('input',{bubbles:true}))}`)
      await evaluate(`${tab('image.png')}.querySelector('[role="tab"]').click()`)
      await waitFor('!!document.querySelector(".file-image-preview img")')
      await unmount()
      await evaluate('window.failImage=true')
      await remount()
      await waitFor('document.querySelector(".preview-empty")?.textContent.includes("Could not reload this image")')
      assert.equal(await evaluate('document.querySelector(".preview-empty").textContent.includes("5 MB")'), false)
      await evaluate('window.failImage=false')
      await clickText('Retry preview')
      await waitFor('!!document.querySelector(".file-image-preview img")')
      await evaluate(`${tab('draft.txt')}.querySelector('[role="tab"]').click()`)
      await waitFor('document.querySelector("textarea")?.value === "Unsaved draft"')
      assert.equal(await evaluate('window.saves.length'), 0, 'Eviction does not save or discard drafts')

      // A rename during rehydration must retain the tab and ignore the old-path read.
      await evaluate(`${tab('image.png')}.querySelector('[role="tab"]').click()`)
      await unmount()
      await evaluate('window.deferImage=true')
      await remount()
      await waitFor('!!window.pendingImage')
      await clickText('Rename')
      await waitFor('!!document.querySelector(".file-entry-modal input")')
      await evaluate(`{const e=document.querySelector('.file-entry-modal input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'renamed.png');e.dispatchEvent(new Event('input',{bubbles:true}))}`)
      await clickText('Rename item')
      await waitFor(`${tab('renamed.png')}?.classList.contains('selected') && !!document.querySelector('.file-image-preview img')`)
      await evaluate('window.resolveImage()')
      await evaluate('new Promise(done=>setTimeout(done,30))')
      assert.equal(await evaluate(`${tab('image.png')}===null && ${tab('renamed.png')}.classList.contains('selected')`), true)
      assert.equal(await evaluate(`${tab('renamed.png')}.classList.contains('temporary')`), false)
      process.stdout.write('Files image cache UI passed: bounded eviction, selected-image reload, stale cancellation, retry, draft preservation, and rename.\n')
      window.destroy()
      app.exit(0)
    } catch (error) { console.error(error); window.destroy(); app.exit(1) }
  })
}

function fixture() {
  return `
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {FilesPanel} from './src/renderer/src/components/FilesPanel';
    const image='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH9sAAAAASUVORK5CYII=';
    let imagePath='image.png';const entries=()=>[imagePath,'draft.txt'].map(path=>({path,name:path,kind:'file',size:100}));
    const preview=path=>({path,content:path.endsWith('.png')?'':'Original text',binary:path.endsWith('.png'),truncated:false,imageMimeType:path.endsWith('.png')?'image/png':null,imageDataUrl:path.endsWith('.png')?image:null});
    window.saves=[];window.reads=[];window.deferImage=false;window.failImage=false;window.pendingImage=null;
    window.resolveImage=()=>{const done=window.pendingImage;window.pendingImage=null;window.deferImage=false;done?.()};
    window.projectConsole={files:{list:async()=>entries(),search:async()=>entries(),
      preview:async(projectId,path)=>{window.reads.push(path);if(path==='image.png'&&window.failImage)throw new Error('SSH fixture unavailable');if(path==='image.png'&&window.deferImage)await new Promise(done=>window.pendingImage=done);return preview(path)},
      rename:async(projectId,path,name)=>{imagePath=name;return name},
      save:async(...args)=>window.saves.push(args)},system:{openExternal:async()=>{}}};
    const root=createRoot(document.getElementById('root'));let mounted=true;
    window.changeFiles=change=>{mounted=change.mounted;root.render(mounted?<FilesPanel project={{id:'fixture',name:'Fixture',connectionId:'ssh:fixture',folder:'/fixture',sessions:[]}}/>:null)};
    window.changeFiles({mounted:true});
  `
}
