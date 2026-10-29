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
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-html-ui-'))
  try {
    await build({
      stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js'),
      plugins: [{ name: 'fixture-editor', setup(build) {
        build.onResolve({ filter: /\/lib\/monaco$/ }, () => ({ path: 'fixture-editor', namespace: 'fixture' }))
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: editorStub(), loader: 'tsx', resolveDir: root }))
      } }]
    })
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
  setTimeout(() => { process.stderr.write('HTML UI smoke test timed out.\n'); app.exit(1) }, 40_000).unref()
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1320, height: 850, show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    window.webContents.on('console-message', (event) => { if (event.level === 'error') process.stderr.write(`Renderer: ${event.message}\n`) })
    const evaluate = (code) => window.webContents.executeJavaScript(code).catch((error) => { throw new Error(`Evaluation failed: ${code.slice(0,200)}\n${error.message}`) })
    const waitFor = async (code) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 50))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    const clickText = (text) => evaluate(`Array.from(document.querySelectorAll('button')).find(el=>el.textContent.trim()===${JSON.stringify(text)}).click()`)
    const frame = `document.querySelector('.html-preview-frame')`
    const doc = `${frame}?.contentDocument`
    const network = []
    try {
      const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
      const markdownCss = await readFile(join(root, 'src/renderer/src/markdown-preview.css'), 'utf8')
      const index = await readFile(join(root, 'src/renderer/index.html'), 'utf8')
      const csp = index.match(/content="(default-src[^"]+)"/)[1]
      const html = `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css}${markdownCss}#root{display:flex}.files-panel{flex:1}textarea{width:100%;height:100%}</style></head><body><div id="root"></div></body></html>`
      await writeFile(join(temp, 'index.html'), html)
      await window.loadFile(join(temp, 'index.html'))
      window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (details, done) => {
        network.push(details.url)
        done({ cancel: true })
      })
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await waitFor(`document.querySelector('.file-list button')`)
      await evaluate(`Array.from(document.querySelectorAll('.file-list button')).find(el=>el.querySelector('span')?.textContent==='index.html').click()`)
      await waitFor(`${doc}?.getElementById('hero') && ${doc}.readyState==='complete'`)
      assert.equal(await evaluate(`document.querySelector('[aria-label="HTML view"] button').getAttribute('aria-pressed')`), 'true')
      assert.equal(await evaluate(`${frame}.contentWindow.getComputedStyle(${doc}.getElementById('hero')).color`), 'rgb(18, 52, 86)')
      assert.equal(await evaluate(`${doc}.querySelector('img').complete && ${doc}.querySelector('img').naturalWidth===1`), true)
      assert.equal(await evaluate(`${frame}.sandbox.contains('allow-scripts')`), false)
      assert.equal(await evaluate(`${frame}.contentWindow.projectConsole===undefined && !window.hacked`), true)
      assert.equal(await evaluate(`${doc}.querySelectorAll('script,iframe,object,embed,meta[http-equiv=refresh]').length`), 0)
      assert.equal(await evaluate(`${doc}.querySelector('input').disabled`), true)
      assert.deepEqual(await evaluate(`window.assetReads.map(x=>x.path).sort()`), ['assets/pixel.png', 'index.html', 'styles/theme.css'])
      assert.equal(await evaluate(`window.assetReads.every(x=>x.projectId==='remote-project')`), true)
      assert.equal(await evaluate(`${frame}.contentWindow.getComputedStyle(${doc}.getElementById('hero')).backgroundImage.startsWith('url("data:image/png')`), true)
      await evaluate(`${doc}.getElementById('external').click()`)
      await waitFor(`window.openedExternal==='https://example.com/docs'`)
      await evaluate(`${doc}.getElementById('jump').click()`)
      assert.equal(await evaluate(`${doc}.scrollingElement.scrollTop>0`), true)
      if (process.env.PANEPILOT_UI_SCREENSHOT) {
        await evaluate(`{ const frameDocument=${doc}; frameDocument.scrollingElement.scrollTop=0 }`)
        await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      }
      await clickText('Source')
      await waitFor(`document.querySelector('[aria-label="Source editor"]')`)
      assert.equal(await evaluate(`document.querySelector('[aria-label="Source editor"]').readOnly`), true)
      await clickText('Edit')
      await evaluate(`{
        const input=document.querySelector('[aria-label="Source editor"]');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'<h1 id="draft">Unsaved draft</h1>');
        input.dispatchEvent(new Event('input',{bubbles:true}));
      }`)
      await clickText('Preview')
      await waitFor(`${doc}?.getElementById('draft')?.textContent==='Unsaved draft'`)
      assert.equal(await evaluate(`window.saves`), 0)
      await evaluate(`Array.from(document.querySelectorAll('.file-list button')).find(el=>el.querySelector('span')?.textContent==='readme.md').click()`)
      await waitFor(`document.querySelector('.markdown-body')?.textContent.includes('Markdown still works')`)
      await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(el=>el.textContent.includes('index.html')).click()`)
      await waitFor(`${doc}?.getElementById('draft')`)
      await clickText('Cancel')
      await waitFor(`${doc}?.getElementById('hero')`)
      await evaluate(`${doc}.getElementById('local').click()`)
      await waitFor(`${doc}?.getElementById('second')`)
      assert.equal(await evaluate(`window.fileOpens.at(-1)`), 'pages/second.htm')
      await evaluate(`window.openAtLine()`)
      await waitFor(`document.querySelector('[aria-label="Source editor"]') && window.revealed?.lineNumber===4`)
      await evaluate(`window.remountFiles()`)
      await waitFor(`document.querySelector('[aria-label="Source editor"]')`)
      await clickText('Preview')
      await waitFor(`${doc}?.getElementById('hero')`)
      const limits = await evaluate(`window.checkAssetLimits()`)
      assert.equal(limits.reads, 16)
      assert.equal(limits.maxConcurrent, 3)
      assert.equal(limits.limited, true)
      assert.equal(limits.unavailable, 4)
      assert.equal(await evaluate(`window.checkAbort()`), 3)
      const expanded = await evaluate(`window.checkExpandedBudget()`)
      assert.equal(expanded.reads, 1, 'Repeated assets reuse a single bounded file read')
      assert.equal(expanded.limited, true)
      assert.equal(expanded.length < 17 * 1024 * 1024, true, 'Inlining repeated large assets remains bounded')
      assert.deepEqual(network, [], 'HTML must not request remote assets or direct local files')
      process.stdout.write('HTML preview passed: default mode, HTML/CSS/images, draft retention, Markdown, links/anchors, line targets, sandbox/no network, asset bounds and cancellation.\n')
      window.destroy()
      app.exit(0)
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`)
      process.stderr.write(`${await evaluate(`document.querySelector('.html-preview-shell')?.outerHTML.slice(0,3000)`).catch(()=>'')}\n`)
      window.destroy()
      app.exit(1)
    }
  })
}

function editorStub() {
  return `import React,{useEffect} from 'react';
    export const monaco={};export function discardEditorDraft(){}export function forgetEditorModel(){}
    export function Editor({value,onChange,onMount,options}) {
      useEffect(()=>{onMount({addAction:()=>({dispose(){}}),setPosition(p){window.revealed=p},revealPositionInCenter(){},focus(){}})},[]);
      return <textarea aria-label="Source editor" value={value} readOnly={options.readOnly} onChange={event=>onChange(event.target.value)}/>;
    }`
}

function fixture() {
  return `
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {FilesPanel} from './src/renderer/src/components/FilesPanel';
    import {buildHtmlPreview} from './src/renderer/src/lib/htmlPreview';
    const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9XcAAAAASUVORK5CYII=';
    const source=\`<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="styles/theme.css">
      <meta http-equiv="refresh" content="0;url=https://example.invalid/redirect"><base href="https://example.invalid/">
      <style>@import 'https://example.invalid/import.css'; body{margin:36px;font-family:system-ui} .hero{padding:24px;background:#eef1f8;border-radius:18px} .below{margin-top:1200px} .remote{background:url(https://example.invalid/track)}</style>
      <script>top.hacked=true;fetch('https://example.invalid/script')</script></head>
      <body><section class="hero"><h1 id="hero">A project, in preview.</h1><p>HTML and CSS, kept inside their own canvas.</p><img src="assets/pixel.png" onerror="top.hacked=true"><img src="https://example.invalid/pixel.png"><img src="../escape.png"></section>
      <p><a id="external" href="https://example.com/docs" target="_top">Open external</a> · <a id="local" href="pages/second.htm#second">Open project page</a> · <a id="jump" href="#below">Jump down</a></p>
      <form action="https://example.invalid/form"><input value="Static form"><button>Submit</button></form>
      <iframe srcdoc="<script>top.hacked=true</script>"></iframe><object data="file:///etc/passwd"></object>
      <svg><use href="https://example.invalid/svg#icon"/><a href="javascript:top.hacked=true">Unsafe</a></svg>
      <h2 class="below" id="below">Anchor destination</h2></body></html>\`;
    const preview=(path,content)=>({path,content,truncated:false,binary:false,imageMimeType:null,imageDataUrl:null});
    const files={ 'index.html':preview('index.html',source), 'readme.md':preview('readme.md','# Markdown still works'),
      'pages/second.htm':preview('pages/second.htm','<h1 id="second">Second page</h1>'),
      'styles/theme.css':preview('styles/theme.css','#hero {color:#123456;background-image:url("../assets/pixel.png")} /* </style><meta http-equiv="refresh" content="0;url=https://example.invalid/css-breakout"> */'),
      'assets/pixel.png':{...preview('assets/pixel.png',''),binary:true,imageMimeType:'image/png',imageDataUrl:pixel}};
    const entries=['index.html','readme.md'].map(path=>({path,name:path,kind:'file',size:100}));
    window.assetReads=[];window.fileOpens=[];window.saves=0;
    window.projectConsole={files:{list:async()=>entries,preview:async(projectId,path)=>{window.assetReads.push({projectId,path});if(!files[path])throw Error('Missing');return files[path]},
      open:async(projectId,path)=>{window.fileOpens.push(path);return {kind:'file',path,directoryPath:'.',entries,preview:files[path]}},
      save:async()=>{window.saves++}},system:{openExternal:async(url)=>{window.openedExternal=url}}};
    const project={id:'remote-project',name:'HTML previews',connectionId:'ssh:fixture',folder:'/project',sessions:[]};
    const root=createRoot(document.getElementById('root'));let revision=0;
    const render=(request=null)=>root.render(<FilesPanel key={revision} project={project} openFileRequest={request}/>);
    window.openAtLine=()=>render({projectId:project.id,requestId:1,path:'index.html',line:4,column:2});
    window.remountFiles=()=>{revision++;render()};render();
    window.checkAssetLimits=async()=>{
      let reads=0,running=0,maxConcurrent=0;
      const result=await buildHtmlPreview(Array.from({length:20},(_,i)=>'<img src="image'+i+'.png">').join(''),'index.html',async(path)=>{
        reads++;running++;maxConcurrent=Math.max(running,maxConcurrent);await new Promise(done=>setTimeout(done,5));running--;
        return {...preview(path,''),imageDataUrl:pixel,imageMimeType:'image/png'};
      },new AbortController().signal);
      return {reads,maxConcurrent,limited:result.limited,unavailable:result.unavailable};
    };
    window.checkAbort=async()=>{
      let reads=0;const controller=new AbortController();
      const pending=buildHtmlPreview(Array.from({length:20},(_,i)=>'<img src="image'+i+'.png">').join(''),'index.html',async(path)=>{
        reads++;await new Promise(done=>setTimeout(done,20));return {...preview(path,''),imageDataUrl:pixel};
      },controller.signal).catch(()=>null);
      await new Promise(done=>setTimeout(done,5));controller.abort();await pending;return reads;
    };
    window.checkExpandedBudget=async()=>{
      let reads=0;
      const result=await buildHtmlPreview('<img src="large.png">'.repeat(40),'index.html',async(path)=>{
        reads++;return {...preview(path,''),imageDataUrl:'data:image/png;base64,'+'A'.repeat(1024*1024)};
      },new AbortController().signal);
      return {reads,length:result.html.length,limited:result.limited};
    };
  `
}
