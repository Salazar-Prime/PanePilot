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
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-file-tabs-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'fixture-editor', setup(builder) {
        builder.onResolve({ filter: /\/lib\/monaco$/ }, () => ({ path: 'editor', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'tsx', resolveDir: root, contents: `
          import React,{useEffect} from 'react';export const monaco={};
          export function Editor({value,onChange,onMount,options}){
            useEffect(()=>{onMount({addAction:()=>({dispose(){}}),setPosition(p){window.revealed=p},revealPositionInCenter(){},focus(){}})},[]);
            return <textarea aria-label="Source editor" value={value} readOnly={options.readOnly} onChange={e=>onChange(e.target.value)}/>;
          }` }))
      } }] })
    const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${css}html,body,#root{height:100%;margin:0}#root{display:flex}textarea{width:100%;height:100%}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
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
  setTimeout(() => { process.stderr.write('File tabs test timed out.\n'); app.exit(1) }, 40_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1450, height: 760, show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const row = (path) => `Array.from(document.querySelectorAll('.file-row')).find(e=>e.querySelector('span')?.textContent===${JSON.stringify(path)})`
    const tab = (path) => `document.querySelector('[data-file-path="${path}"]')`
    const open = async (path) => {
      await evaluate(`${row(path)}.click()`)
      await waitFor(`${tab(path)}?.classList.contains('selected')`)
    }
    const tabs = () => evaluate(`Array.from(document.querySelectorAll('.file-preview-tab'),e=>({path:e.dataset.filePath,temporary:e.classList.contains('temporary')}))`)
    const clickText = (text) => evaluate(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`)
    try {
      await window.loadFile(join(temp, 'index.html'))
      for (const projectId of ['local-files', 'ssh-files']) {
        await evaluate(`window.changeFiles({projectId:${JSON.stringify(projectId)},request:null})`)
        await waitFor(`document.querySelector('.file-row')!==null`)
        await open('alpha.txt')
        await open('bravo.txt')
        assert.deepEqual(await tabs(), [{ path: 'bravo.txt', temporary: true }])
        assert.equal(await evaluate(`getComputedStyle(${tab('bravo.txt')}.querySelector('span')).fontStyle`), 'italic')
        await evaluate(`${tab('bravo.txt')}.querySelector('[role="tab"]').click()`)
        await waitFor(`!${tab('bravo.txt')}.classList.contains('temporary')`)
        await open('alpha.txt')
        await evaluate(`${row('alpha.txt')}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}))`)
        await waitFor(`!${tab('alpha.txt')}.classList.contains('temporary')`)
        await open('image.png')
        await open('data.bin')
        assert.deepEqual((await tabs()).map((file) => file.path), ['bravo.txt', 'alpha.txt', 'data.bin'])
        await open('index.html')
        await waitFor(`document.querySelector('.html-preview-frame')!==null`)
        await open('readme.md')
        await waitFor(`document.querySelector('.markdown-body')?.textContent.includes('Readme')`)
        assert.equal((await tabs()).filter((file) => file.temporary).length, 1)

        // Double-click while a remote preview is pending promotes that one read.
        await evaluate(`window.deferPaths.add('slow.txt');${row('slow.txt')}.click()`)
        await waitFor(`!!window.pending['slow.txt']`)
        await evaluate(`${row('slow.txt')}.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:2}));${row('slow.txt')}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}))`)
        assert.equal(await evaluate(`window.reads.filter(e=>e.projectId===${JSON.stringify(projectId)}&&e.path==='slow.txt').length`), 1)
        await evaluate(`window.resolveFile('slow.txt')`)
        await waitFor(`${tab('slow.txt')} && !${tab('slow.txt')}.classList.contains('temporary')`)

        await open('draft.txt')
        await clickText('Edit')
        await waitFor(`!${tab('draft.txt')}.classList.contains('temporary')`)
        await evaluate(`{const e=document.querySelector('[aria-label="Source editor"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Unsaved draft');e.dispatchEvent(new Event('input',{bubbles:true}))}`)
        await open('fresh.txt')
        await evaluate(`${tab('draft.txt')}.querySelector('[role="tab"]').click()`)
        await waitFor(`document.querySelector('[aria-label="Source editor"]')?.value==='Unsaved draft'`)
        await evaluate(`${tab('draft.txt')}.querySelector('.file-preview-tab-close').click()`)
        assert.equal(await evaluate(`${tab('draft.txt')}!==null`), true, 'Unsaved close retains the discard confirmation')

        // Slow older files cannot replace a newer preview or steal an explicit tab selection.
        await evaluate(`window.deferPaths.add('late.txt');${row('late.txt')}.click()`)
        await waitFor(`!!window.pending['late.txt']`)
        await open('latest.txt')
        await evaluate(`window.resolveFile('late.txt')`)
        await evaluate(`new Promise(done=>setTimeout(done,50))`)
        assert.equal(await evaluate(`${tab('late.txt')}===null && ${tab('latest.txt')}.classList.contains('selected')`), true)
        await evaluate(`window.deferPaths.add('late.txt');${row('late.txt')}.click()`)
        await waitFor(`!!window.pending['late.txt']`)
        await evaluate(`${tab('draft.txt')}.querySelector('[role="tab"]').click();window.resolveFile('late.txt')`)
        await waitFor(`document.querySelector('[aria-label="Source editor"]')?.value==='Unsaved draft'`)
        assert.equal(await evaluate(`${tab('late.txt')}===null`), true)

        // Linked line targets use the temporary slot and retain Source/reveal behavior.
        await evaluate(`window.changeFiles({request:{projectId:${JSON.stringify(projectId)},requestId:++window.requestId,path:'linked.md',line:3,column:2}})`)
        await waitFor(`${tab('linked.md')}?.classList.contains('temporary') && window.revealed?.lineNumber===3`)
        const before = await tabs()
        await evaluate(`window.changeFiles({mounted:false})`)
        await waitFor(`!document.querySelector('.files-layout')`)
        await evaluate(`window.changeFiles({mounted:true,request:null})`)
        await waitFor(`${tab('linked.md')}?.classList.contains('selected')`)
        assert.deepEqual(await tabs(), before, 'Temporary and kept tabs survive capability switches')
        await evaluate(`${tab('draft.txt')}.querySelector('[role="tab"]').click()`)
        await waitFor(`document.querySelector('[aria-label="Source editor"]')?.value==='Unsaved draft'`)
        await clickText('Save')
        await waitFor(`window.saves.some(s=>s.projectId===${JSON.stringify(projectId)}&&s.path==='draft.txt'&&s.content==='Unsaved draft')`)
        assert.equal((await tabs()).find((file) => file.path === 'draft.txt').temporary, false)
        if (process.env.PANEPILOT_UI_SCREENSHOT) {
          await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
        }
      }

      // Edits made while another preview is loading must win over replacement.
      await evaluate(`window.changeFiles({projectId:'race-files',request:null})`)
      await waitFor(`document.querySelector('.file-row')!==null`)
      await open('alpha.txt')
      await evaluate(`window.deferPaths.add('late.txt');${row('late.txt')}.click()`)
      await waitFor(`!!window.pending['late.txt']`)
      await clickText('Edit')
      await evaluate(`{const e=document.querySelector('[aria-label="Source editor"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Typed during remote read');e.dispatchEvent(new Event('input',{bubbles:true}))}`)
      await evaluate(`window.resolveFile('late.txt')`)
      await waitFor(`${tab('late.txt')}?.classList.contains('temporary')`)
      assert.equal(await evaluate(`${tab('alpha.txt')}!==null && !${tab('alpha.txt')}.classList.contains('temporary')`), true)
      await evaluate(`${tab('alpha.txt')}.querySelector('[role="tab"]').click()`)
      await waitFor(`document.querySelector('[aria-label="Source editor"]')?.value==='Typed during remote read'`)

      // Search results stay mounted when their file lives in a different directory.
      await evaluate(`{const e=document.querySelector('[aria-label="Search project files"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'guide');e.dispatchEvent(new Event('input',{bubbles:true}))}`)
      await waitFor(`${row('docs/guide.txt')}!==undefined`)
      await evaluate(`void(window.searchRow=${row('docs/guide.txt')});window.searchRow.click()`)
      await waitFor(`${tab('docs/guide.txt')}?.classList.contains('temporary')`)
      assert.equal(await evaluate(`window.searchRow===${row('docs/guide.txt')}`), true)
      await evaluate(`window.searchRow.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,detail:2}))`)
      await waitFor(`!${tab('docs/guide.txt')}.classList.contains('temporary')`)
      assert.deepEqual(await evaluate(`window.errors`), [])
      process.stdout.write('File tabs passed: single preview slot, keep-on-tab-click/double-click, delayed double-click coalescing, edit/draft protection, latest intent, linked Source/reveal, cache restoration, local and SSH projects.\n')
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
    import {FilesPanel} from './src/renderer/src/components/FilesPanel';
    const paths=['alpha.txt','bravo.txt','image.png','data.bin','index.html','readme.md','slow.txt','draft.txt','fresh.txt','late.txt','latest.txt','linked.md','docs/guide.txt'];
    const entries=paths.map(path=>({path,name:path.split('/').at(-1),kind:'file',size:100}));
    const preview=path=>({path,content:path.endsWith('.md')?'# Readme\\nline two\\nline three':path.endsWith('.html')?'<h1>HTML</h1>':path,binary:/\\.(png|bin)$/.test(path),truncated:false,imageMimeType:path.endsWith('.png')?'image/png':null,imageDataUrl:path.endsWith('.png')?'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9XcAAAAASUVORK5CYII=':null});
    window.errors=[];window.addEventListener('error',e=>window.errors.push(e.message));window.confirm=()=>false;
    window.reads=[];window.saves=[];window.pending={};window.deferPaths=new Set();window.requestId=0;
    window.resolveFile=path=>{const resolve=window.pending[path];delete window.pending[path];window.deferPaths.delete(path);resolve(preview(path))};
    window.projectConsole={files:{list:async()=>entries,search:async(projectId,query)=>entries.filter(e=>e.path.includes(query)),preview:async(projectId,path)=>{window.reads.push({projectId,path});if(window.deferPaths.has(path))return new Promise(done=>window.pending[path]=done);return preview(path)},
      open:async(projectId,path)=>({kind:'file',path,directoryPath:'.',entries,preview:preview(path)}),save:async(projectId,path,content)=>{window.saves.push({projectId,path,content})}},system:{openExternal:async()=>{}}};
    const root=createRoot(document.getElementById('root'));let state={projectId:'local-files',mounted:true,request:null};
    const render=()=>root.render(state.mounted?<FilesPanel project={{id:state.projectId,name:'Files',connectionId:state.projectId==='local-files'?'local':'ssh:fixture',folder:'/fixture',sessions:[]}} openFileRequest={state.request}/>:null);
    window.changeFiles=change=>{state={...state,...change};render()};render();
  `
}
