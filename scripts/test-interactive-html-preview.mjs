import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const demo = process.env.PANEPILOT_HTML_DEMO
const sample = `<!doctype html><html><head><style>body{background:#101216;color:#eee;font-family:system-ui;padding:24px}#gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.tile{padding:20px;background:#292e38}svg{width:100%}</style></head>
  <body><h1>Interactive collage fixture</h1><div id="count-buttons"></div><input type="range" id="packing" value="90"><div id="gallery-state"></div><div id="gallery"></div>
  <script src="space-fill-geometry.js"></script><script src="space-fill-render.js"></script></body></html>`

if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-html-interactive-'))
  try {
    const source = demo ? await readFile(demo, 'utf8') : sample
    const path = demo ? basename(demo) : 'index.html'
    await build({ stdin: { contents: fixture(source, path), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js') })
    await build({ stdin: { contents: `export * from './src/main/html-interactive-preview'; export {previewLocalFileAsync} from './src/main/file-service';`, resolveDir: root, loader: 'ts' },
      bundle: true, platform: 'node', format: 'esm', packages: 'external', outfile: join(temp, 'service.mjs') })
    await writeFile(join(temp, 'preload.cjs'), `const {contextBridge,ipcRenderer}=require('electron');if(process.isMainFrame)contextBridge.exposeInMainWorld('fixtureApi',{
      start:input=>ipcRenderer.invoke('fixture:start',input),close:id=>ipcRenderer.invoke('fixture:close',id),
      preview:path=>ipcRenderer.invoke('fixture:preview',path),probe:url=>ipcRenderer.invoke('fixture:probe',url),
      stats:()=>ipcRenderer.invoke('fixture:stats'),delay:()=>ipcRenderer.invoke('fixture:delay')});`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject); child.once('exit', done)
    })
    if (code !== 0) process.exitCode = 1
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow, ipcMain, protocol } = await import('electron')
  const temp = process.argv[2]
  const { InteractiveHtmlPreviewService, HTML_PREVIEW_SCHEME, HTML_PREVIEW_PRIVILEGES, guardInteractiveHtmlNavigation, previewLocalFileAsync } = await import(join(temp, 'service.mjs'))
  protocol.registerSchemesAsPrivileged([{ scheme: HTML_PREVIEW_SCHEME, privileges: HTML_PREVIEW_PRIVILEGES }])
  app.setPath('userData', join(temp, 'profile'))
  setTimeout(() => { process.stderr.write('Interactive HTML test timed out.\n'); app.exit(1) }, 60_000).unref()
  void app.whenReady().then(async () => {
    const source = demo ? await readFile(demo, 'utf8') : sample
    const preview = (path, content) => ({ path, content, binary: false, truncated: false, imageMimeType: null, imageDataUrl: null })
    const files = {
      'index.html': sample,
      'space-fill-geometry.js': 'window.SpaceFillGeometry={families:Array.from({length:6},(_,i)=>i)};',
      'space-fill-render.js': `window.spaceFillDemo={state:{count:5,packing:.9}};const state=window.spaceFillDemo.state;
        const render=()=>{document.getElementById('gallery').innerHTML=SpaceFillGeometry.families.map(i=>'<article class="tile"><svg><circle cx="40" cy="40" r="30" fill="pink"/></svg>'+state.count+' photos</article>').join('');document.getElementById('gallery-state').textContent=state.count+' photos';};
        for(let n=2;n<=8;n++){const button=document.createElement('button');button.textContent=n;button.dataset.count=n;button.onclick=()=>{state.count=n;render()};document.getElementById('count-buttons').append(button)}
        document.getElementById('packing').oninput=e=>state.packing=Number(e.target.value)/100;render();document.body.dataset.demoReady='true';`,
      'module.mjs': 'export const ready=true;'
    }
    const loader = async (_project, path) => {
      if (demo) return previewLocalFileAsync(dirname(demo), path)
      if (!(path in files)) throw Error('Missing fixture asset')
      return preview(path, files[path])
    }
    const service = new InteractiveHtmlPreviewService(loader)
    protocol.handle(HTML_PREVIEW_SCHEME, request => service.handle(request))
    const window = new BrowserWindow({ width: 1320, height: 900, show: false, webPreferences: {
      preload: join(temp, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, backgroundThrottling: false
    } })
    guardInteractiveHtmlNavigation(window.webContents, service)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const opened = [], closed = [], network = []
    let delayNext = false
    const trusted = event => { assert.equal(event.senderFrame, window.webContents.mainFrame) }
    ipcMain.handle('fixture:start', async (event, input) => {
      trusted(event)
      if (delayNext) { delayNext = false; await new Promise(done => setTimeout(done, 150)) }
      const result = await service.open(event.sender.id, input); opened.push(result); return result
    })
    ipcMain.handle('fixture:close', (event, id) => { trusted(event); closed.push(id); service.close(event.sender.id, id) })
    ipcMain.handle('fixture:preview', (event, path) => { trusted(event); return loader('fixture', path) })
    ipcMain.handle('fixture:probe', async (event, url) => { trusted(event); return (await service.handle(new Request(url))).status })
    ipcMain.handle('fixture:stats', event => { trusted(event); return { opened, closed } })
    ipcMain.handle('fixture:delay', event => { trusted(event); delayNext = true })
    const evaluate = code => window.webContents.executeJavaScript(code)
    const child = () => window.webContents.mainFrame.frames.find(frame => frame.url.startsWith(`${HTML_PREVIEW_SCHEME}:`))
    const inChild = code => { assert.ok(child(), 'Interactive frame exists'); return child().executeJavaScript(code) }
    const waitFor = async (check, label) => {
      for (let i = 0; i < 150; i++) { if (await check()) return; await new Promise(done => setTimeout(done, 40)) }
      throw Error(`UI did not settle: ${label}`)
    }
    const click = text => evaluate(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(text)}).click()`)
    try {
      const index = await readFile(join(root, 'src/renderer/index.html'), 'utf8')
      const csp = index.match(/content="(default-src[^"]+)"/)[1]
      const css = await Promise.all(['styles.css', 'markdown-preview.css'].map(name => readFile(join(root, 'src/renderer/src', name), 'utf8')))
      await writeFile(join(temp, 'index.html'), `<html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>${css.join('\n')}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div></body></html>`)
      await window.loadFile(join(temp, 'index.html'))
      const appUrl = window.webContents.getURL()
      window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'file://*/*'] }, (details, done) => {
        if (details.resourceType === 'mainFrame' && details.url === appUrl) { done({ cancel: false }); return }
        network.push(details.url); done({ cancel: true })
      })
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await waitFor(() => evaluate(`!!document.querySelector('iframe[sandbox="allow-same-origin"]')?.contentDocument?.getElementById('gallery')`), 'static preview')
      assert.equal(await evaluate(`document.querySelector('iframe').contentDocument.getElementById('gallery').children.length`), 0)
      await click('Interactive')
      await waitFor(() => child() ? inChild(`document.body?.dataset.demoReady==='true'`) : false, 'dynamic collage gallery')
      assert.equal(await inChild(`document.querySelectorAll('#gallery .tile').length`), 6)
      assert.equal(await inChild(`document.querySelectorAll('#gallery svg').length`), 6)
      assert.equal(await inChild(`document.querySelectorAll('#count-buttons button').length`), 7)
      assert.equal(await inChild(`typeof projectConsole==='undefined' && typeof fixtureApi==='undefined' && typeof require==='undefined' && typeof process==='undefined'`), true)
      assert.equal(await inChild(`(()=>{try{void parent.document;return false}catch{return true}})()`), true)
      assert.equal(await inChild(`self.origin`), 'null')
      await inChild(`document.querySelector('#count-buttons [data-count="8"]').click();document.getElementById('packing').value='50';document.getElementById('packing').dispatchEvent(new Event('input',{bubbles:true}));`)
      await waitFor(() => inChild(`window.spaceFillDemo.state.count===8 && window.spaceFillDemo.state.packing===.5 && document.getElementById('gallery-state').textContent.includes('8 photos')`), 'working controls')
      if (demo) {
        await inChild(`document.getElementById('hero').click();document.getElementById('ratio').value='1:1';document.getElementById('ratio').dispatchEvent(new Event('change',{bubbles:true}));document.getElementById('overlap').value='25';document.getElementById('overlap').dispatchEvent(new Event('input',{bubbles:true}));`)
        await waitFor(() => inChild(`spaceFillDemo.state.hero && spaceFillDemo.state.height===600 && spaceFillDemo.state.overlap===.25 && document.getElementById('gallery-state').textContent.includes('1:1') && document.getElementById('overlap-output').textContent==='25%' && document.getElementById('packing-output').textContent==='50%'`), 'hero, aspect ratio, and overlap controls')
      }
      if (process.env.PANEPILOT_UI_SCREENSHOT) await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      assert.equal(await inChild(`fetch('https://example.invalid/track').then(()=>false,()=>true)`), true)
      assert.equal(await inChild(`fetch('file:///etc/passwd').then(()=>false,()=>true)`), true)
      assert.equal(await inChild(`fetch(new URL('/.git/config',location)).then(response=>response.status)`), 404)
      assert.equal(await inChild(`fetch(location.href,{method:'POST',body:'write'}).then(response=>response.status)`), 405)
      if (!demo) assert.equal(await inChild(`import(new URL('module.mjs',location).href).then(module=>module.ready)`), true)
      assert.equal(await inChild(`(()=>{try{return window.open('https://example.invalid/popup')===null}catch{return true}})()`), true)
      const oldUrl = child().url
      await inChild(`location.href='https://example.invalid/escape'`)
      await new Promise(done => setTimeout(done, 150))
      // A CSP-blocked error frame can retain the attempted URL as metadata; no request may leave.
      assert.equal(window.webContents.getURL().startsWith('file:'), true)
      assert.equal(BrowserWindow.getAllWindows().length, 1)
      assert.deepEqual(network, [], 'Preview must not issue external or direct filesystem requests')
      const firstId = opened.at(-1).id
      await click('Reload')
      await waitFor(() => opened.at(-1).id !== firstId && child() ? inChild(`document.body?.dataset.demoReady==='true'`) : false, 'reload')
      assert.equal(closed.includes(firstId), true)
      assert.equal((await service.handle(new Request(oldUrl))).status, 404)
      const lastId = opened.at(-1).id
      await click('Static')
      await waitFor(() => evaluate(`!!document.querySelector('iframe[sandbox="allow-same-origin"]')`), 'back to static')
      await waitFor(() => closed.includes(lastId), 'token revoked')
      await evaluate(`window.fixtureApi.delay()`)
      await click('Interactive'); await click('Static')
      await new Promise(done => setTimeout(done, 300))
      assert.equal(closed.includes(opened.at(-1).id), true, 'Late open is revoked after changing mode')
      await click('Interactive')
      await waitFor(() => child() ? inChild(`document.body?.dataset.demoReady==='true'`) : false, 'interactive again')
      const unmounted = opened.at(-1).id
      await evaluate(`window.unmountPreview()`)
      await waitFor(() => closed.includes(unmounted), 'unmount cleanup')
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await click('Interactive')
      await waitFor(() => child() ? inChild(`document.body?.dataset.demoReady==='true'`) : false, 'preview before renderer reload')
      const beforeReload = child().url
      await new Promise((done) => { window.webContents.once('did-finish-load', done); window.webContents.reload() })
      assert.equal((await service.handle(new Request(beforeReload))).status, 404, 'Renderer reload revokes capabilities even without React cleanup')
      process.stdout.write(`Interactive HTML passed${demo ? ' for the supplied collage demo' : ''}: sibling scripts, gallery/SVG rendering, controls, opaque origin, no app/Node access, network/navigation/write restrictions, modules, reload and revocation.\n`)
      window.destroy(); app.exit(0)
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`)
      process.stderr.write(`${await evaluate(`document.getElementById('root').textContent`).catch(() => '')}\n`)
      window.destroy(); app.exit(1)
    }
  })
}

function fixture(content, path) {
  return `import React from 'react';import{createRoot}from'react-dom/client';import{HtmlPreview}from'./src/renderer/src/components/HtmlPreview';
    window.projectConsole={files:{preview:(_project,path)=>window.fixtureApi.preview(path),openInteractiveHtml:input=>window.fixtureApi.start(input),closeInteractiveHtml:id=>window.fixtureApi.close(id)},system:{openExternal:async()=>{throw Error('Unexpected external link')}}};
    const root=createRoot(document.getElementById('root'));window.unmountPreview=()=>root.unmount();
    root.render(<HtmlPreview projectId="fixture" path={${JSON.stringify(path)}} content={${JSON.stringify(content)}} onOpenProjectPath={()=>{}} onError={console.error}/>);`
}
