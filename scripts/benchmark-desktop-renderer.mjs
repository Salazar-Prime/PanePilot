import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir, cpus, platform, arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Isolated component workload: real React/Electron/layout, fake PDF.js and IPC.
// Never imports the app main process, opens a user project, or connects to SSH.
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-renderer-benchmark-'))
  const outputIndex = process.argv.indexOf('--output')
  const output = resolve(root, outputIndex >= 0 ? process.argv[outputIndex + 1] : 'audit/desktop-2026-10-29/renderer-benchmark.json')
  try {
    await build({
      stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'isolated-renderer-fixture', setup(builder) {
        builder.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: 'pdf', namespace: 'fixture' }))
        builder.onResolve({ filter: /^pdfjs-dist\/.+\?url$/ }, () => ({ path: 'worker', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'worker' ? 'export default ""' : pdfStub(), loader: 'js' }))

      }}]
    })
    await writeFile(join(temp, 'index.html'), '<html><head><meta charset="UTF-8"><style>html,body,#root{height:100%;margin:0}.latex-pdf-preview{height:100%;display:flex;flex-direction:column}.latex-pdf-pasteboard{overflow:auto;flex:1;min-height:0}.latex-pdf-page{position:relative;margin:20px auto}.latex-pdf-toolbar{height:60px;flex:none}.latex-pdf-page canvas{display:block}.markdown-preview-scroll img{width:1px;height:1px}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>')
    if (process.argv.includes('--setup-only')) {
      process.stdout.write('Renderer benchmark fixture compiled successfully; timed benchmark not run.\n')
    } else {
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const code = await new Promise((done, reject) => {
        const child = spawn(createRequire(import.meta.url)('electron'), [script, temp, output], { env, stdio: 'inherit' })
        child.once('error', reject)
        child.once('exit', (status) => done(status ?? 1))
      })
      process.exitCode = code
    }
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  const output = process.argv[3]
  app.setPath('userData', join(temp, 'profile'))
  app.setPath('sessionData', join(temp, 'session'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  app.on('window-all-closed', () => {})
  // Electron Ready occurs after ESM evaluation; don't await it at module scope.
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1200, height: 850, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await evaluate(code)) return
        await delay(20)
      }
      throw new Error(`Fixture did not settle: ${code}`)
    }
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor('typeof window.renderPdf === "function"')
      window.webContents.debugger.attach('1.3')
      const heap = async () => {
        await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage')
        return await window.webContents.debugger.sendCommand('Runtime.getHeapUsage')
      }
      const initialHeap = await heap()
      const pageCases = []
      for (const pages of [10, 100, 500]) {
        const samples = []
        for (let repeat = 0; repeat < 3; repeat++) {
          await evaluate(`window.renderPdf(${JSON.stringify(`pages-${pages}-${repeat}`)},${pages},1024)`)
          await waitFor('window.fixtureStats.documentsCreated===1 && document.querySelectorAll("[data-pdf-page]").length>0')
          const initialSettleMs = await evaluate('performance.now()-window.fixtureStats.startedAt')
          await delay(100)
          samples.push({ ...await evaluate('window.readFixtureStats()'), initialSettleMs })
          await evaluate('window.unmountFixture()')
          await delay(30)
        }
        pageCases.push({ pages, samples })
      }
      const cacheBefore = await evaluate('window.pdfCacheStats()')
      const heapBefore = await heap()
      const projects = 8
      const pdfBytes = 2 * 1024 * 1024
      for (let index = 0; index < projects; index++) {
        await evaluate(`window.renderPdf(${JSON.stringify(`retained-${index}`)},1,${pdfBytes})`)
        await waitFor('window.fixtureStats.getPageCalls>=1')
        await evaluate('window.unmountFixture()')
        await delay(30)
      }
      const cacheAfter = await evaluate('window.pdfCacheStats()')
      const heapAfter = await heap()
      assert.equal(await evaluate('document.querySelectorAll("[data-pdf-page]").length'), 0, 'PDF components unmounted before memory read')
      const markdownCases = []
      for (const images of [10, 100, 500]) {
        await evaluate(`window.renderMarkdown(${images})`)
        // React commits image elements before the resource effect starts. Require
        // every image to have a final status, rather than accepting that gap.
        await waitFor(`document.querySelectorAll('.markdown-body img[data-markdown-image-status]:not([data-markdown-image-status="queued"])').length===${images} && window.fixtureStats.imageInFlight===0`)
        markdownCases.push({
          ...await evaluate('window.readFixtureStats()'),
          inputImages: images,
          imageLimited: await evaluate('document.querySelectorAll(\'img[data-markdown-image-status="limited"]\').length')
        })
        await evaluate('window.unmountFixture()')
        await delay(30)
      }
      const report = {
        capturedAt: new Date().toISOString(),
        environment: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, electron: process.versions.electron, chromium: process.versions.chrome },
        method: 'Production React components bundled with esbuild. Hidden sandboxed Electron window, 1200x850, backgroundThrottling false, isolated throwaway profile; actual component code and DOM layout, fake PDF.js and fake projectConsole. The PDF fixture mirrors the snapshot IPC shape without retaining returned data; renderer cache measurements exclude the main-process snapshot store, measured separately by benchmark-pdf-snapshots.mjs.',
        limitations: ['initialSettleMs is observed at 20ms polling resolution; elapsedMs additionally includes a 100ms observation window. Neither measures PDF parsing/rendering or actual disk/SSH latency.', 'Fake PDF pages draw nothing. getPage counts verify eagerness, not real PDF.js CPU cost. The fixture does not measure hot/cold main-process snapshot retention; run benchmark-pdf-snapshots.mjs for that workload.', 'Heap after explicit GC separates V8 heap usedSize from external backingStorageSize (including strings); excludes renderer RSS, GPU memory, PDF workers and browser native allocations.', 'Markdown image requests return tiny fake previews after 25ms. Peak concurrency measures attempted component IPC fan-out, not real file sizes or SSH connections.', 'This is not a battery/power benchmark and no watt or full-application CPU claim is made.'],
        initialHeap, pageCases,
        retainedSnapshots: { projectsVisited: projects, syntheticPdfBytesEach: pdfBytes, cacheBefore, cacheAfter, heapBefore, heapAfter, usedHeapDeltaBytes: heapAfter.usedSize - heapBefore.usedSize, backingStorageDeltaBytes: heapAfter.backingStorageSize - heapBefore.backingStorageSize, cacheBase64DeltaCharacters: cacheAfter.base64Characters - cacheBefore.base64Characters, currentMountedPages: await evaluate('document.querySelectorAll("[data-pdf-page]").length') },
        markdownCases
      }
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
      process.stdout.write(`Renderer benchmark written to ${output}\n`)
      window.destroy()
      app.exit(0)
    } catch (error) {
      console.error(error)
      window.destroy()
      app.exit(1)
    }
  })
}

function pdfStub() {
  return `export const GlobalWorkerOptions={};
  export function getDocument(){const stats=window.fixtureStats;stats.documentsCreated++;const pages=stats.pages;return{promise:Promise.resolve({numPages:pages,
    getPage:async(n)=>{stats.getPageCalls++;stats.uniquePages.add(n);return {getViewport:({scale})=>({width:612*scale,height:792*scale}),render:()=>{stats.renderCalls++;return {promise:Promise.resolve(),cancel(){}}}}},
    destroy:async()=>{stats.documentsDestroyed++}})}}`
}

function fixture() {
  return `import React from 'react';import{createRoot}from'react-dom/client';
    import{LatexPdfPreview}from'./src/renderer/src/components/LatexPdfPreview';
    import{MarkdownPreview}from'./src/renderer/src/components/MarkdownPreview';
    const root=createRoot(document.getElementById('root'));let revision=0;let input={};
    function reset(kind,pages=0){window.fixtureStats={kind,pages,getPageCalls:0,uniquePages:new Set(),renderCalls:0,documentsCreated:0,documentsDestroyed:0,imageRequests:0,imageInFlight:0,imagePeak:0,imageCompleted:0,startedAt:performance.now()};}
    reset('initial');
    window.pdfCacheStats=()=>({projects:0,base64Characters:0,scope:'renderer only; snapshot storage benchmarked separately'});
    window.projectConsole={latex:{acceptPdfSnapshot:async()=>{},releasePdfSnapshot:async()=>{},getPdfSnapshot:async(id)=>{const bytes=new Uint8Array(input.bytes);let seed=1;for(const c of id)seed=(Math.imul(seed,31)+c.charCodeAt(0))|0;for(let i=0;i<bytes.length;i++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;bytes[i]=seed&255;}let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return {snapshotId:id,path:'main.pdf',size:bytes.length,modifiedAt:'fixture',dataBase64:btoa(binary)};},sourceRevision:async()=> 'unchanged'},files:{preview:async()=>{const s=window.fixtureStats;s.imageRequests++;s.imageInFlight++;s.imagePeak=Math.max(s.imagePeak,s.imageInFlight);await new Promise(r=>setTimeout(r,25));s.imageInFlight--;s.imageCompleted++;return {imageDataUrl:null};}}};
    window.renderPdf=(id,pages,bytes)=>{reset('pdf',pages);input={bytes};root.render(<LatexPdfPreview key={id} projectId={id} mainFile='main.tex' local/>);};
    window.renderMarkdown=(images)=>{reset('markdown');const content=Array.from({length:images},(_,i)=>'![Figure '+i+'](images/figure-'+i+'.png)').join('\\n');root.render(<MarkdownPreview key={++revision} projectId='images' path='README.md' content={content} onOpenProjectPath={()=>{}} onError={()=>{}}/>);};
    window.unmountFixture=()=>root.render(null);
    window.readFixtureStats=()=>{const {uniquePages,startedAt,...rest}=window.fixtureStats;return {...rest,uniquePageCount:uniquePages.size,pageShells:document.querySelectorAll('[data-pdf-page]').length,elapsedMs:performance.now()-startedAt,documentHidden:document.hidden};};`
}
