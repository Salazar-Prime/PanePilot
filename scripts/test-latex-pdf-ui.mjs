import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Real React component + production snapshot store, isolated Electron; PDF.js is
// instrumented so page acquisition and snapshot identity are directly observable.
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-pdf-ui-'))
  try {
    await build({ entryPoints: [join(root, 'src/main/pdf-snapshot-store.ts')], bundle: true,
      platform: 'node', format: 'cjs', outfile: join(temp, 'snapshots.cjs') })
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root }, bundle: true,
      platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(temp, 'fixture.js'),
      define: { 'process.env.NODE_ENV': '"production"' }, alias: { '@shared': join(root, 'src/shared') },
      plugins: [{ name: 'observable-pdf', setup(builder) {
        builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: 'pdf', namespace: 'fixture' }))
        builder.onResolve({ filter: /^pdfjs-dist\/.+\?url$/ }, () => ({ path: 'worker', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'worker' ? 'export default ""' : pdfStub(), loader: 'js' }))
      }}] })
    await writeFile(join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');
      contextBridge.exposeInMainWorld('projectConsole',{latex:{
        getPdfSnapshot:(id,path)=>ipcRenderer.invoke('pdf:open',id,path),
        compilePdfSnapshot:(id)=>ipcRenderer.invoke('pdf:compile',id),
        readPdfSnapshot:(id)=>ipcRenderer.invoke('pdf:read',id),
        acceptPdfSnapshot:(id)=>ipcRenderer.invoke('pdf:accept',id),
        releasePdfSnapshot:(id)=>ipcRenderer.invoke('pdf:release',id),
        printPdf:(input)=>ipcRenderer.invoke('pdf:print',input),sourceRevision:async()=> 'same'},files:{showInFolder:async()=>{}}});
      contextBridge.exposeInMainWorld('fixtureApi',{configure:(...args)=>ipcRenderer.invoke('fixture:configure',...args),stats:()=>ipcRenderer.invoke('fixture:stats')});`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    process.exitCode = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject); child.once('exit', (code) => done(code ?? 1))
    })
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  const temp = process.argv[2]
  const { PdfSnapshotStore } = createRequire(import.meta.url)(join(temp, 'snapshots.cjs'))
  const snapshots = new PdfSnapshotStore({ hotBytes: 8192, temporaryRoot: temp })
  const sources = new Map()
  const prints = []
  let diskReads = 0
  const load = (id) => {
    diskReads++
    const source = sources.get(id)
    if (!source) throw new Error('Unconfigured project')
    const bytes = Buffer.alloc(4096, 32)
    bytes.write('%PDF-' + JSON.stringify(source) + '\n')
    return { path: 'main.pdf', size: bytes.length, modifiedAt: 'same-time', dataBase64: bytes.toString('base64') }
  }
  ipcMain.handle('fixture:configure', (_e, id, pages, marker, compact = false) => { sources.set(id, { pages, marker, compact }) })
  ipcMain.handle('fixture:stats', () => ({ ...snapshots.stats(), diskReads, prints }))
  ipcMain.handle('pdf:open', (_e, id) => snapshots.acquire(1, id, async () => load(id)))
  ipcMain.handle('pdf:compile', (_e, id) => snapshots.acquire(1, id, async () => load(id), true))
  ipcMain.handle('pdf:accept', (_e, id) => snapshots.accept(1, id))
  ipcMain.handle('pdf:read', (_e, id) => snapshots.read(1, id))
  ipcMain.handle('pdf:release', (_e, id) => snapshots.release(1, id))
  ipcMain.handle('pdf:print', (_e, document) => { prints.push(JSON.parse(Buffer.from(document.dataBase64, 'base64').toString('utf8').split('\n')[0].slice(5)).marker) })
  app.setPath('userData', join(temp, 'profile'))
  app.setPath('sessionData', join(temp, 'session'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  setTimeout(() => { process.stderr.write('PDF UI fixture timed out.\n'); app.exit(1) }, 60_000).unref()
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1200, height: 850, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
        backgroundThrottling: false, preload: join(temp, 'preload.cjs') } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let index = 0; index < 250; index++) { if (await evaluate(code)) return; await delay(20) }
      throw new Error(`PDF fixture did not settle: ${code}`)
    }
    try {
      const css = await readFile(join(root, 'src/renderer/src/latex-pdf.css'), 'utf8')
      await writeFile(join(temp, 'index.html'), `<html><head><meta charset="UTF-8"><style>${css}\nhtml,body,#root{height:100%;margin:0}#root{display:flex}.pane{height:100%;min-width:0;flex:1}.latex-pdf-preview{height:100%;display:flex;flex-direction:column}.latex-pdf-toolbar{flex:none}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
      await window.loadFile(join(temp, 'index.html'))
      await waitFor('typeof window.showPanes === "function"')
      await evaluate(`window.fixtureApi.configure('long',500,'long-original')`)
      await evaluate(`window.showPanes([{key:'long',project:'long'}])`)
      await waitFor(`document.querySelectorAll('[data-pdf-page]').length===500 && window.pdfStats.getPageCalls>0`)
      await delay(100)
      const firstCalls = await evaluate('window.pdfStats.getPageCalls')
      assert.ok(firstCalls < 10, `Initial acquisition must remain near viewport, got ${firstCalls}`)
      await evaluate(`window.pdfStats.geometryReads=0;const r=document.querySelector('.latex-pdf-pasteboard');const p=document.querySelector('[data-pdf-page="400"]');r.scrollTop+=p.getBoundingClientRect().top-r.getBoundingClientRect().top-20;r.dispatchEvent(new Event('scroll'));`)
      await waitFor(`Number(document.querySelector('input[type=number]').value)>=399`)
      await delay(100)
      assert.ok(await evaluate('window.pdfStats.getPageCalls') < 20, 'Jumping does not acquire intervening pages')
      assert.ok(await evaluate('window.pdfStats.geometryReads') < 100, 'Scroll locates pages without 500 geometry reads per frame')
      assert.ok(await evaluate(`document.querySelector('[data-pdf-page="400"]').style.width.startsWith('792')`), 'Visited variable-size landscape page uses actual dimensions')
      const savedReading = await evaluate('window.readView()')
      await evaluate(`window.showPanes([]);window.evictGeometry()`)
      await waitFor(`!document.querySelector('.latex-pdf-preview')`)
      await evaluate(`window.fixtureApi.configure('long',2,'external-replacement')`)
      await evaluate(`window.showPanes([{key:'long-return',project:'long'}])`)
      await waitFor(`document.querySelectorAll('[data-pdf-page]').length===500`)
      await waitFor(`Number(document.querySelector('input[type=number]').value)===${savedReading.page}`)
      await delay(50)
      assert.ok(Math.abs((await evaluate('window.readView()')).offset - savedReading.offset) < 2, 'Page-relative offset survives geometry metadata eviction')
      await evaluate(`document.querySelector('.latex-pdf-print-button').click()`)
      await waitFor(`!document.querySelector('.latex-pdf-print-button').disabled`)
      assert.equal(prints.at(-1), 'long-original', 'Revisit prints original displayed bytes, never external replacement')
      const beforeZoom = await evaluate('window.readView()')
      await evaluate(`document.querySelector('[aria-label="Zoom in"]').click()`)
      await delay(100)
      const afterZoom = await evaluate('window.readView()')
      assert.equal(afterZoom.page, beforeZoom.page)
      assert.ok(Math.abs(afterZoom.offset - beforeZoom.offset * 1.25) < 2, 'Zoom preserves the page-relative reading point')
      await evaluate(`window.fixtureApi.configure('long',500,'long-compiled',true)`)
      await evaluate(`document.querySelector('.latex-pdf-compile-button').click()`)
      await waitFor(`window.pdfStats.lastDocument==='long-compiled' && !document.querySelector('.latex-pdf-compile-button').disabled`)
      await delay(100)
      const afterCompile = await evaluate('window.readView()')
      assert.equal(afterCompile.page, afterZoom.page)
      assert.ok(Math.abs(afterCompile.offset - afterZoom.offset) < 2, 'Recompile preserves reading point when page dimensions change')
      await evaluate(`window.fixtureApi.configure('long',500,'bad-pdf')`)
      await evaluate(`document.querySelector('.latex-pdf-compile-button').click()`)
      await waitFor(`document.querySelector('.latex-pdf-inline-error')?.textContent.includes('Malformed fixture PDF')`)
      await evaluate(`window.showPanes([])`)
      await waitFor(`!document.querySelector('.latex-pdf-preview')`)
      await evaluate(`window.showPanes([{key:'after-invalid',project:'long'}])`)
      await waitFor(`document.querySelector('.latex-pdf-preview') && window.pdfStats.lastDocument==='long-compiled'`)
      await evaluate(`document.querySelector('.latex-pdf-print-button').click()`)
      await waitFor(`!document.querySelector('.latex-pdf-print-button').disabled`)
      assert.equal(prints.at(-1), 'long-compiled', 'Failed PDF.js parse never replaces accepted latest snapshot')
      assert.equal(await evaluate('window.pdfStats.failedTasksDestroyed'), 1)


      await evaluate(`window.fixtureApi.configure('split',1,'split-old')`)
      await evaluate(`window.showPanes([{key:'left',project:'split'},{key:'right',project:'split'}])`)
      await waitFor(`document.querySelectorAll('.latex-pdf-preview').length===2`)
      await evaluate(`window.fixtureApi.configure('split',1,'split-new')`)
      await evaluate(`document.querySelector('.pane[data-pane=left] .latex-pdf-compile-button').click()`)
      await waitFor(`!document.querySelector('.pane[data-pane=left] .latex-pdf-compile-button').disabled`)
      await evaluate(`document.querySelector('.pane[data-pane=left] .latex-pdf-print-button').click()`)
      await waitFor(`!document.querySelector('.pane[data-pane=left] .latex-pdf-print-button').disabled`)
      await evaluate(`document.querySelector('.pane[data-pane=right] .latex-pdf-print-button').click()`)
      await waitFor(`!document.querySelector('.pane[data-pane=right] .latex-pdf-print-button').disabled`)
      assert.deepEqual(prints.slice(-2), ['split-new', 'split-old'], 'Each pane prints its own snapshot, even with matching path/timestamp')
      await evaluate(`window.showPanes([])`)
      await waitFor(`!document.querySelector('.latex-pdf-preview')`)
      await delay(50)
      assert.equal(snapshots.stats().snapshots, 2, 'Obsolete split snapshot was collected after both panes released it')

      for (let index = 0; index < 8; index++) {
        await evaluate(`window.fixtureApi.configure('cold-${index}',1,'cold-original-${index}')`)
        await evaluate(`window.showPanes([{key:'cold-${index}',project:'cold-${index}'}])`)
        await waitFor(`document.querySelector('.latex-pdf-preview') && window.pdfStats.lastDocument==='cold-original-${index}'`)
      }
      assert.ok(snapshots.stats().hotBytes <= 8192)
      await evaluate(`window.fixtureApi.configure('cold-0',1,'newer-disk-copy')`)
      const readsBefore = diskReads
      await evaluate(`window.showPanes([{key:'cold-return',project:'cold-0'}])`)
      await waitFor(`window.pdfStats.lastDocument==='cold-original-0'`)
      assert.equal(diskReads, readsBefore)
      await evaluate(`document.querySelector('.latex-pdf-print-button').click()`)
      await waitFor(`!document.querySelector('.latex-pdf-print-button').disabled`)
      assert.equal(prints.at(-1), 'cold-original-0')
      await evaluate(`window.showPanes([])`)
      await waitFor(`!document.querySelector('.latex-pdf-preview')`)
      await delay(50)
      assert.equal(await evaluate('window.pdfStats.documentsCreated'), await evaluate('window.pdfStats.documentsDestroyed'))
      await snapshots.disposeOwner(1)
      assert.equal((await readdir(temp)).filter((name) => name.startsWith('panepilot-pdf-snapshots-')).length, 0)
      process.stdout.write(JSON.stringify({ passed: true, initialGetPageCalls500Pages: firstCalls,
        assertions: ['near-viewport page acquisition', 'bounded scroll geometry reads', 'variable page dimensions', 'reading-position restore after geometry eviction', 'zoom/compile reading anchor', 'failed PDF parse retention and loading-task cleanup', 'immutable external-change revisit', 'split-pane exact printed snapshot', 'hot-budget cold revisit', 'PDF document destruction', 'owner temporary-file cleanup'] }) + '\n')
      window.destroy(); app.exit(0)
    } catch (error) {
      console.error(error); await snapshots.dispose(); window.destroy(); app.exit(1)
    }
  })
}

function pdfStub() {
  return `export const GlobalWorkerOptions={};export function getDocument({data}) {
    const spec=JSON.parse(new TextDecoder().decode(data).split('\\n')[0].slice(5));const stats=window.pdfStats;
    if(spec.marker==='bad-pdf')return{promise:Promise.reject(new Error('Malformed fixture PDF')),destroy:async()=>{stats.failedTasksDestroyed++}};
    stats.documentsCreated++;stats.lastDocument=spec.marker;return {promise:Promise.resolve({numPages:spec.pages,
      getPage:async(n)=>{stats.getPageCalls++;return {getViewport:({scale})=>({width:(n%4===0?792:612)*scale,height:(n%4===0?612:792)*scale*(spec.compact?0.8:1)}),render:()=>({promise:Promise.resolve(),cancel(){}})}},
      destroy:async()=>{stats.documentsDestroyed++}})}}`
}
function fixture() {
  return `import React from 'react';import{createRoot}from'react-dom/client';import{LatexPdfPreview}from'./src/renderer/src/components/LatexPdfPreview';import{savePdfPageSize}from'./src/renderer/src/lib/pdfPageLayout';
    const root=createRoot(document.getElementById('root'));window.pdfStats={documentsCreated:0,documentsDestroyed:0,getPageCalls:0,geometryReads:0,failedTasksDestroyed:0,lastDocument:''};
    const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){if(this.hasAttribute('data-pdf-page'))window.pdfStats.geometryReads++;return rect.call(this)};
    window.evictGeometry=()=>{for(let n=0;n<4097;n++)savePdfPageSize('evict',n,{width:612,height:792})};
    window.readView=()=>{const root=document.querySelector('.latex-pdf-pasteboard');const page=Number(document.querySelector('input[type=number]').value);const element=root.querySelector('[data-pdf-page=\"'+page+'\"]');return {page,scrollTop:root.scrollTop,offset:root.getBoundingClientRect().top-element.getBoundingClientRect().top}};
    window.showPanes=(panes)=>root.render(<>{panes.map(p=><div className='pane' key={p.key} data-pane={p.key}><LatexPdfPreview projectId={p.project} mainFile='main.tex' local/></div>)}</>);`
}
