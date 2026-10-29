// Usage: node scripts/test-packaged-renderer.mjs <app.asar/out/renderer/index.html> [report.json]
// Runs only the packaged renderer with synthetic projects, files, terminal output and PDF.
// The application main process is never loaded. A disposable Electron profile and
// explicit IPC stubs keep this check away from real workspaces, providers and SSH.
// Nonlocal network requests fail the check. This is a functional smoke test, not a benchmark.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const packagePath = (value) => value.replace(/^.*?([^/]+\.app\/Contents\/Resources\/app\.asar\/)/, '$1')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
if (!process.versions.electron) {
  assert.ok(process.argv[2], 'Usage: node scripts/test-packaged-renderer.mjs <app.asar/out/renderer/index.html> [report.json]')
  const index = resolve(process.argv[2])
  assert.ok(index.endsWith('/app.asar/out/renderer/index.html'), 'Provide an actual packaged app.asar renderer index.')
  const report = resolve(process.argv[3] ?? '/tmp/panepilot-packaged-renderer-smoke.json')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-packaged-renderer-smoke-'))
  try {
    await writeFile(join(temp, 'preload.cjs'), preload())
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(join(root, 'package.json'))('electron')
    process.exitCode = await new Promise((done, reject) => {
      const child = spawn(electron, [script, index, report, temp], { env, stdio: 'inherit' })
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Packaged renderer smoke timed out after 45 seconds.')) }, 45_000)
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', (status) => { clearTimeout(timeout); done(status ?? 1) })
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const [index, output, temp] = process.argv.slice(2)
  app.setPath('userData', join(temp, 'profile'))
  app.setPath('sessionData', join(temp, 'session'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  app.on('window-all-closed', () => {})
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: {
      preload: join(temp, 'preload.cjs'), contextIsolation: true, sandbox: true,
      nodeIntegration: false, backgroundThrottling: false
    } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const logs = [], failedRequests = [], blockedRequests = []
    window.webContents.on('console-message', (event) => { const { level, message } = event; if (level === 'warning' || level === 'error') logs.push({ level, message }) })
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = ['file:', 'blob:', 'data:', 'about:'].includes(new URL(details.url).protocol)
      if (!allowed) blockedRequests.push(details.url)
      callback({ cancel: !allowed })
    })
    window.webContents.session.webRequest.onErrorOccurred((details) => failedRequests.push({ url: details.url, error: details.error }))
    const waitFor = async (condition, label = condition) => {
      for (let attempt = 0; attempt < 250; attempt++) {
        if (await evaluate(condition)) return
        await delay(40)
      }
      throw new Error(`Smoke condition failed: ${label}`)
    }
    const clickText = async (selector, label) => {
      const expression = `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).find(e => e.textContent.trim() === ${JSON.stringify(label)})`
      await waitFor(`!!(${expression})`, `find ${selector}: ${label}`)
      await evaluate(`${expression}.click()`)
    }
    const workerFor = (name) => `window.smokeWorkers.some(w => w.url.includes(${JSON.stringify(name)}) && w.messages > 0)`
    try {
      await window.loadURL('data:text/html,' + encodeURIComponent('<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;">'));
      window.webContents.debugger.attach('1.3')
      await window.webContents.debugger.sendCommand('Page.enable')
      await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
        window.smokeWorkers=[]; window.smokeErrors=[];
        const OriginalWorker=window.Worker;
        window.Worker=class extends OriginalWorker {
          constructor(url,options){super(url,options);const record={url:String(url),messages:0,errors:[]};window.smokeWorkers.push(record);
            this.addEventListener('message',()=>record.messages++);
            this.addEventListener('error',event=>record.errors.push(event.message));}
        };
        addEventListener('error',event=>window.smokeErrors.push(event.message));
        addEventListener('unhandledrejection',event=>window.smokeErrors.push(String(event.reason)));
      ` })
      await window.loadFile(index)
      await waitFor('document.querySelectorAll(".project-row").length === 2', 'synthetic projects mounted')
      await clickText('.session-row .sidebar-row-main', 'Smoke shell')
      await waitFor('document.querySelector(".xterm-rows")?.textContent.includes("PACKAGED_XTERM_OK")', 'xterm rendered synthetic ANSI output')
      await clickText('.workspace-tabs button', 'Files')
      await waitFor('document.querySelectorAll(".file-row").length >= 5', 'synthetic file listing')
      for (const [file, worker] of [['sample.ts', 'ts.worker'], ['sample.json', 'json.worker'], ['sample.css', 'css.worker'], ['sample.html', 'html.worker']]) {
        await clickText('.file-row span', file)
        if (file.endsWith('.html')) await clickText('.preview-mode-switch button', 'Source')
        await waitFor('!!document.querySelector(".file-editor-shell .monaco-editor")', `Monaco mounted for ${file}`)
        await waitFor(workerFor(worker), `real worker replies for ${file}`)
      }
      await waitFor(workerFor('editor.worker'), 'real Monaco editor worker replies')
      await clickText('.project-row .sidebar-row-main', 'Smoke manuscript')
      await waitFor('!!document.querySelector(".latex-project-workspace .monaco-editor")', 'LaTeX Monaco mounted')
      await clickText('.workspace-tabs button', 'PDF Preview')
      await waitFor(workerFor('pdf.worker'), 'real PDF.js worker replies')
      await waitFor('Array.from(document.querySelectorAll("[data-pdf-page] canvas")).some(c=>c.width > 100 && c.height > 100)', 'PDF.js canvas rendered')
      await waitFor('document.querySelector("[data-pdf-page]")?.getAttribute("aria-busy") === "false"', 'PDF.js render completed');
      const pixels = await evaluate(`(() => {
        const canvas=document.querySelector('[data-pdf-page] canvas'); const data=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
        let black=0,white=0; for(let i=0;i<data.length;i+=4){if(data[i]<8&&data[i+1]<8&&data[i+2]<8)black++;if(data[i]>247&&data[i+1]>247&&data[i+2]>247)white++;}
        return {width:canvas.width,height:canvas.height,black,white};})()`)
      assert.ok(pixels.black > 1000 && pixels.white > 1000, 'PDF canvas must contain synthetic rectangle and white page')
      const workers = await evaluate('window.smokeWorkers')
      assert.ok(workers.length >= 6 && workers.every((worker) => worker.url.includes('/app.asar/out/renderer/assets/')), 'Every worker must load from the actual packaged archive')
      const errors = await evaluate('window.smokeErrors')
      assert.deepEqual(workers.flatMap((worker) => worker.errors), [], 'worker error events')
      assert.deepEqual(errors, [], 'renderer errors')
      assert.deepEqual(failedRequests, [], 'asset load failures')
      assert.deepEqual(blockedRequests, [], 'unexpected network attempts')
      assert.deepEqual(logs.filter((entry) => entry.level === 'error'), [], 'renderer console errors')
      const report = { capturedAt: new Date().toISOString(), rendererIndex: packagePath(index), electron: process.versions.electron,
        method: 'Loads actual built renderer assets in sandboxed Electron with a disposable profile and explicit synthetic projectConsole preload. No application main process, actual user data, provider archives, SSH, or network. Checks UI mounting, xterm synthetic ANSI output, Files language workers and PDF.js parsing/rendering; no timing benchmark.',
        passed: true, workers: workers.map((worker) => ({ ...worker, url: packagePath(worker.url) })), pdfCanvas: pixels, logs, failedRequests, blockedRequests, errors,
        limits: ['Synthetic IPC fixtures do not validate production IPC/main-process behavior.', 'Uses installed Electron runtime with packaged renderer assets, not production application launch.'] }
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, JSON.stringify(report, null, 2) + '\n')
      console.log(`Packaged renderer smoke passed: ${output}`)
      window.destroy(); app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ logs, failedRequests, blockedRequests, errors: await evaluate('window.smokeErrors').catch(() => null), workers: await evaluate('window.smokeWorkers').catch(() => null), body: await evaluate('document.body.innerText.slice(-5000)').catch(() => null) }, null, 2))
      window.destroy(); app.exit(1)
    }
  })
}

function pdfBase64() {
  const stream = '0 0 0 rg 30 30 100 100 re f\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}endstream`
  ]
  let pdf='%PDF-1.4\n'; const offsets = [0]
  objects.forEach((body,index) => { offsets.push(Buffer.byteLength(pdf)); pdf+=`${index+1} 0 obj\n${body}\nendobj\n` })
  const xref = Buffer.byteLength(pdf)
  pdf+=`xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf).toString('base64')
}

function preload() {
  return `const {contextBridge}=require('electron');
    const noop=()=>{}; const unsubscribe=()=>noop; const empty=async()=>[];
    const contents={'sample.ts':'const answer: number = 42;\\nconsole.log(answer);','sample.json':'{"answer":42}','sample.css':'body { color: red; }','sample.html':'<!doctype html><html><body>Smoke HTML</body></html>','main.tex':'\\\\documentclass{article}\\n\\\\begin{document}\\nSmoke manuscript.\\n\\\\end{document}'};
    const entries=Object.entries(contents).map(([name,content])=>({name,path:name,kind:'file',size:content.length}));
    const preview=(path)=>({path,content:contents[path]??'',truncated:false,binary:false,imageMimeType:null,imageDataUrl:null});
    const common={icon:null,connectionId:'local',folder:'/synthetic/packaged-smoke',repositoryUrl:null,state:'idle',archived:false,createdAt:'2026-01-01',updatedAt:'2026-01-01',sessions:[],actions:[],activities:[]};
    const details={projectId:'smoke-latex',mainFile:'main.tex',overleafUrl:null,contextFolder:'.'};
    const session={id:'smoke-shell',projectId:'smoke-files',kind:'terminal',name:'Smoke shell',profile:'shell',providerSessionId:null,providerSessionName:null,customCommand:null,backend:'pty',tmuxName:null,state:'running',dangerousMode:false,archived:false,pinned:false,flagged:false,output:'',latexChat:null,createdAt:'2026-01-01',updatedAt:'2026-01-01'};
    const projects=[{...common,id:'smoke-files',type:'terminal',name:'Smoke files',latex:null,sessions:[session]},{...common,id:'smoke-latex',type:'latex',name:'Smoke manuscript',latex:details}];
    const pdf=${JSON.stringify(pdfBase64())};
    contextBridge.exposeInMainWorld('projectConsole',{
      updates:{get:async()=>({phase:'disabled',currentVersion:'smoke',version:null,percent:null,stage:'download',message:'Smoke'}),onChanged:unsubscribe},
      connections:{list:async()=>[{id:'local',name:'Synthetic local',kind:'local',sshAlias:null}]},
      projects:{list:async()=>projects,get:async(id)=>projects.find(p=>p.id===id)},
      terminals:{onState:unsubscribe,onMetadata:unsubscribe,onTransport:unsubscribe,onData:unsubscribe,discover:async()=>0,attach:async()=>({output:'\\x1b[32mPACKAGED_XTERM_OK\\x1b[0m\\r\\n'}),resize:async()=>{},acknowledge:async()=>{}},
      actions:{sync:empty},
      git:{status:async()=>({isRepository:false,root:null,originUrl:null,branch:null,detached:false,head:null,upstream:null,ahead:0,behind:0,stashCount:0,clean:true,changes:[],message:null})},
      files:{list:async()=>entries,preview:async(_,path)=>preview(path),open:async(_,path)=>({kind:'file',path,directoryPath:'.',entries,preview:preview(path)}),search:empty},
      googleDrive:{status:async()=>({available:false,connected:false,remoteName:null,folderPath:null,folderUrl:null,destination:null})},
      latex:{getWorkspace:async()=>({details,sections:[],contextAvailable:true}),listComments:empty,listInlineEdits:empty,sourceRevision:async()=>'fixed',getPdf:async()=>({path:'main.pdf',size:pdf.length*3/4,modifiedAt:'2026-01-01T00:00:00.000Z',dataBase64:pdf})},
      workspaceHistory:{setSwitcherOpen:noop},system:{setZoomFactor:noop},portForwards:{onChanged:unsubscribe},terminalDrops:{onProgress:unsubscribe,list:empty}
    });`
}
