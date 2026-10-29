import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Actual MarkdownPreview, production React, isolated Electron profile and fake IPC.
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-markdown-ui-'))
  try {
    await build({
      stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js')
    })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', (status) => done(status ?? 1))
    })
    process.exitCode = code
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  app.setPath('sessionData', join(temp, 'session'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  setTimeout(() => { process.stderr.write('Markdown UI fixture timed out.\n'); app.exit(1) }, 40_000).unref()
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1000, height: 800, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let attempt = 0; attempt < 250; attempt++) {
        if (await evaluate(code)) return
        await delay(20)
      }
      throw new Error(`Markdown fixture did not settle: ${code}`)
    }
    const settle = () => waitFor(`document.querySelectorAll('img[data-markdown-image-status="queued"]').length===0`)
    try {
      const css = await readFile(join(root, 'src/renderer/src/markdown-preview.css'), 'utf8')
      await writeFile(join(temp, 'index.html'), `<html><head><meta charset="UTF-8"><style>${css}</style></head><body><div id="root"></div></body></html>`)
      await window.loadFile(join(temp, 'index.html'))
      const requests = []
      window.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, done) => {
        requests.push(details.url)
        done({ cancel: true })
      })
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await evaluate(`window.show('many', {count:500})`)
      await waitFor(`document.querySelectorAll('img').length===500 && window.records.many.completed===16`)
      await settle()
      assert.deepEqual(await evaluate(`window.stats('many')`), { reads: 16, completed: 16, peak: 3 })
      assert.equal(await evaluate(`document.querySelectorAll('img[data-markdown-image-status="loaded"]').length`), 16)
      assert.equal(await evaluate(`document.querySelectorAll('img[data-markdown-image-status="limited"]').length`), 484)
      assert.equal(await evaluate(`document.querySelector('img[data-markdown-image-status="limited"]').getAttribute('aria-description').includes('16 project images')`), true)

      await evaluate(`window.show('duplicates', {content:'![First](images/shared.png)\\n![Second](./images/shared.png#detail)\\n![Third](/images/shared.png)'})`)
      await waitFor(`window.records.duplicates.completed===1`)
      await settle()
      assert.deepEqual(await evaluate(`window.stats('duplicates')`), { reads: 1, completed: 1, peak: 1 })
      assert.equal(await evaluate(`document.querySelectorAll('img[src]').length`), 3)

      await evaluate(`window.show('unmount', {count:500, hold:true})`)
      await waitFor(`window.records.unmount.reads===3`)
      await evaluate(`window.oldImages=[...document.querySelectorAll('img')];window.unmount()`)
      await waitFor(`!document.querySelector('.markdown-body')`)
      await evaluate(`window.release('unmount')`)
      await waitFor(`window.records.unmount.completed===3`)
      await delay(50)
      assert.equal(await evaluate(`window.records.unmount.reads`), 3, 'Unmount cancels every queued IPC read')
      assert.equal(await evaluate(`window.oldImages.some(image=>image.hasAttribute('src'))`), false, 'Late IPC results do not mutate detached images')

      await evaluate(`window.show('old-project', {count:20, hold:true, path:'old/README.md'})`)
      await waitFor(`window.records['old-project'].reads===3`)
      for (let index = 0; index < 5; index++) {
        await evaluate(`window.show(${JSON.stringify(`skipped-${index}`)}, {count:20, path:'skipped/README.md'})`)
        await delay(20)
      }
      await evaluate(`window.show('new-project', {count:20, path:'new/README.md'})`)
      await delay(20)
      assert.equal(await evaluate(`window.records['new-project'].reads`), 0, 'New document waits for actual old IPC to settle')
      assert.equal(await evaluate(`window.globalReads.peak`), 3, 'Rapid navigation cannot accumulate in-flight reads')
      await evaluate(`window.release('old-project')`)
      await waitFor(`window.records['old-project'].completed===3`)
      await waitFor(`window.records['new-project'].completed===16`)
      await settle()
      assert.equal(await evaluate(`Object.entries(window.records).filter(([id])=>id.startsWith('skipped-')).every(([,record])=>record.reads===0)`), true, 'Superseded queued generations never start IPC')
      assert.equal(await evaluate(`window.records['old-project'].reads`), 3)
      assert.equal(await evaluate(`window.records['new-project'].paths.every(path=>path.startsWith('new/'))`), true)
      assert.equal(await evaluate(`[...document.querySelectorAll('img[src]')].every(image=>image.src.includes('#new-project'))`), true, 'Stale responses cannot replace a newly selected document')

      await evaluate(`window.showMany([['left-pane',{count:3,hold:true}],['right-pane',{count:16}]])`)
      await waitFor(`window.records['left-pane'].reads===3 && document.querySelectorAll('.markdown-body').length===2`)
      await delay(20)
      assert.equal(await evaluate(`window.records['right-pane'].reads`), 0, 'Split previews share the same admission gate')
      await evaluate(`window.release('left-pane')`)
      await waitFor(`window.records['right-pane'].completed===16`)
      await settle()
      assert.equal(await evaluate(`document.querySelectorAll('img[src]').length`), 19)
      assert.equal(await evaluate(`window.globalReads.peak`), 3)

      await evaluate(`window.show('failed-read', {count:16,fail:true})`)
      await waitFor(`window.records['failed-read'].completed===16`)
      await settle()
      assert.equal(await evaluate(`document.querySelectorAll('img[src]').length`), 15, 'A rejected read releases its shared slot')
      assert.equal(await evaluate(`document.querySelectorAll('img[data-markdown-image-status="unavailable"]').length`), 1)

      await evaluate(`window.show('oversized', {count:20, bytes:17*1024*1024})`)
      await waitFor(`window.records.oversized.completed===3`)
      await settle()
      assert.deepEqual(await evaluate(`window.stats('oversized')`), { reads: 3, completed: 3, peak: 3 })
      assert.equal(await evaluate(`document.querySelectorAll('img[src]').length`), 0)
      assert.equal(await evaluate(`document.querySelector('img').getAttribute('aria-description').includes('16 MiB')`), true)

      await evaluate(`window.show('repeated-large', {content:Array(20).fill('![Repeated](large.png)').join('\\n'),bytes:2*1024*1024})`)
      await waitFor(`window.records['repeated-large'].completed===1`)
      await settle()
      assert.equal(await evaluate(`window.records['repeated-large'].reads`), 1)
      assert.equal(await evaluate(`document.querySelectorAll('img[data-markdown-image-status="limited"]').length>0`), true)
      assert.equal(await evaluate(`Array.from(document.querySelectorAll('img')).reduce((n,image)=>n+(image.getAttribute('src')?.length??0),0)<=16*1024*1024`), true, 'Repeated data URLs cannot multiply the DOM byte budget')

      await evaluate(`window.show('aggregate', {count:16,bytes:6*1024*1024})`)
      await waitFor(`window.records.aggregate.completed>=3`)
      await settle()
      assert.equal(await evaluate(`document.querySelectorAll('img[src]').length`), 2, 'Only fitting results enter the aggregate byte budget')
      assert.equal(await evaluate(`window.records.aggregate.reads<16`), true, 'Byte exhaustion cancels queued reads')

      await evaluate(`window.showCompatibility()`)
      await waitFor(`document.querySelector('#safe-link') && document.querySelector('img[data-markdown-src^="https:"]')?.hasAttribute('src')`)
      await settle()
      assert.equal(await evaluate(`document.querySelectorAll('script,iframe,[onerror],img[srcset],input:not([disabled])').length`), 0)
      assert.equal(await evaluate(`window.hacked`), undefined)
      assert.equal(await evaluate(`document.querySelector('img[data-markdown-src^="data:"]').src.startsWith('data:image/png')`), true)
      assert.equal(await evaluate(`document.querySelector('img[data-markdown-src^="http:"]').hasAttribute('src')`), false)
      assert.equal(await evaluate(`document.querySelector('img[data-markdown-src^="https:"]').referrerPolicy`), 'no-referrer')
      await evaluate(`document.querySelector('#safe-link').click();document.querySelector('#project-link').click()`)
      assert.equal(await evaluate(`window.external`), 'https://example.com/docs')
      assert.deepEqual(await evaluate(`window.opened`), { path: 'guide.md', fragment: 'step' })
      assert.equal(requests.every(url => url.startsWith('https://example.invalid/')), true)
      assert.equal(await evaluate(`window.globalReads.peak`), 3)
      process.stdout.write('Markdown preview passed: 500 refs, shared three-read concurrency across navigation/split panes, 16-image/16 MiB admission, dedupe, oversized/repeated results, cancellation, stale project/path results, sanitization and links.\n')
      window.destroy()
      app.exit(0)
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`)
      process.stderr.write(`${await evaluate(`document.querySelector('.markdown-body')?.outerHTML.slice(0,3000)`).catch(() => '')}\n`)
      window.destroy()
      app.exit(1)
    }
  })
}

function fixture() {
  return `import React from 'react';import{createRoot}from'react-dom/client';
    import{MarkdownPreview}from'./src/renderer/src/components/MarkdownPreview';
    const root=createRoot(document.getElementById('root'));
    const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/9XcAAAAASUVORK5CYII=';
    window.records={};window.globalReads={inflight:0,peak:0};
    window.projectConsole={files:{preview:async(projectId,path)=>{
      const record=window.records[projectId];record.reads++;record.paths.push(path);record.inflight++;record.peak=Math.max(record.peak,record.inflight);
      window.globalReads.inflight++;window.globalReads.peak=Math.max(window.globalReads.peak,window.globalReads.inflight);
      if(record.hold)await new Promise(done=>record.pending.push(done));else await new Promise(done=>setTimeout(done,20));
      record.inflight--;record.completed++;window.globalReads.inflight--;
      if(record.fail&&path.endsWith('/0.png'))throw Error('Fixture read failed');
      return {path,content:'',truncated:false,binary:true,imageMimeType:'image/png',imageDataUrl:pixel+'#'+projectId+'x'.repeat(record.bytes??0)};
    }},system:{openExternal:async(url)=>{window.external=url}}};
    const preview=(id,options={})=>{
      window.records[id]={...options,reads:0,completed:0,inflight:0,peak:0,paths:[],pending:[]};
      const content=options.content??Array.from({length:options.count??1},(_,index)=>'![Image '+index+'](images/'+index+'.png)').join('\\n');
      return <MarkdownPreview projectId={id} path={options.path??'README.md'} content={content} onOpenProjectPath={(path,fragment)=>{window.opened={path,fragment}}} onError={()=>{}}/>;
    };
    window.show=(id,options)=>root.render(preview(id,options));
    window.showMany=(entries)=>root.render(<>{entries.map(([id,options])=>React.cloneElement(preview(id,options),{key:id}))}</>);
    window.release=id=>window.records[id].pending.splice(0).forEach(done=>done());
    window.stats=id=>{const {reads,completed,peak}=window.records[id];return {reads,completed,peak}};
    window.unmount=()=>root.render(null);
    window.showCompatibility=()=>window.show('compatibility',{content:'<script>window.hacked=true</script><iframe src="https://example.invalid/frame"></iframe>\\n<input type="checkbox">\\n<img src="'+pixel+'" onerror="window.hacked=true" srcset="https://example.invalid/evil 2x">\\n\\n![Secure](https://example.invalid/image.png)\\n![Blocked](http://example.invalid/image.png)\\n<a id="safe-link" href="https://example.com/docs">External</a> <a id="project-link" href="guide.md#step">Project</a>'});`
}
