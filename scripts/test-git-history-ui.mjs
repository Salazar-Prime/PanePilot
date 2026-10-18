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
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-git-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      loader: { '.css': 'empty' }, alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js') })
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
  setTimeout(() => { process.stderr.write('Git UI test timed out.\n'); app.exit(1) }, 30_000).unref()
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1150, height: 780, show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code).catch((error) => { throw new Error(`Git UI evaluation failed: ${code}\n${error.message}`) })
    const waitFor = async (code) => {
      for (let attempt = 0; attempt < 120; attempt++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 50))
      }
      const diagnostics = await evaluate(`(()=>{
        const list=document.querySelector('.gh-branch-list'), chip=list?.querySelector('[aria-pressed="true"]');
        return {left:list?.scrollLeft,width:list?.clientWidth,total:list?.scrollWidth,list:list?.getBoundingClientRect().toJSON(),chip:chip?.getBoundingClientRect().toJSON()};
      })()`)
      throw new Error(`Git UI did not settle: ${code}\n${JSON.stringify(diagnostics)}`)
    }
    const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
    const search = (value) => evaluate(`{
      const input=document.querySelector('[aria-label="Search branches"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }`)
    const escape = () => evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
    try {
      const styles = await Promise.all(['styles.css', 'git-history.css'].map((name) => readFile(join(root, 'src/renderer/src', name), 'utf8')))
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<html><head><style>${styles.join('\n')}</style></head><body><div id="root"></div></body></html>`)}`)
      await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
      await waitFor(`document.querySelectorAll('.gh-node').length>1 && document.querySelector('.gh-branch-list').scrollWidth>document.querySelector('.gh-branch-list').clientWidth`)
      const timestampsBelowHashes = `Array.from(document.querySelectorAll('.gh-node')).every(node=>{
        const hash=node.querySelector('code'), time=node.querySelector('.gh-node-time');
        return time && time.dateTime==='2026-10-18T12:00:00Z' && time.textContent.trim().length>0 &&
          time.title.includes('2026') && node.title.includes(time.title) &&
          time.getBoundingClientRect().top>=hash.getBoundingClientRect().bottom &&
          parseFloat(getComputedStyle(time).fontSize)>=8;
      })`
      assert.equal(await evaluate(timestampsBelowHashes), true, 'Each hash has a compact timestamp beneath it and a full hover timestamp')
      if (process.env.PANEPILOT_GIT_TIME_SCREENSHOT) await writeFile(process.env.PANEPILOT_GIT_TIME_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      await click('.gh-node[aria-pressed="false"] .gh-node-time')
      assert.equal(await evaluate('window.copies.length'), 0)
      const selected = await evaluate(`document.querySelector('.gh-copy-hash').title.split(': ')[1]`)
      await click('[aria-label="Copy full commit SHA"]')
      await waitFor('window.copies.length===1')
      assert.equal(await evaluate('window.copies[0]'), selected)
      await click('.gh-node[aria-pressed="false"]')
      assert.equal(await evaluate('window.copies.length'), 1)
      assert.equal(await evaluate(`document.querySelector('.gh-footer').textContent.includes('Copied')`), false)

      await click('[aria-label="Scroll branches right"]')
      await waitFor(`document.querySelector('.gh-branch-list').scrollLeft>10`)
      assert.equal(await evaluate(`document.querySelector('.gh-all-branches').getBoundingClientRect().left>=document.querySelector('.git-history-modal').getBoundingClientRect().left`), true)
      await click('[aria-label="Find a branch"]')
      await waitFor(`document.activeElement?.getAttribute('aria-label')==='Search branches'`)
      await search('/249-')
      await waitFor(`document.querySelectorAll('.gh-branch-results [role="option"]').length===1`)
      await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
      await waitFor(`window.gitRequests.at(-1)===window.targetBranch.hash && document.querySelector('.gh-branch-list [aria-pressed="true"]')?.textContent.includes('/249-')`)
      await waitFor(`!document.querySelector('.gh-branch-picker')`)
      await waitFor(`{
        const list=document.querySelector('.gh-branch-list'), chip=list.querySelector('[aria-pressed="true"]');
        chip.getBoundingClientRect().left>=list.getBoundingClientRect().left-2 && chip.getBoundingClientRect().right<=list.getBoundingClientRect().right+2
      }`)
      assert.equal(await evaluate('window.copies.length'), 1)

      await click('[aria-label="Find a branch"]')
      await waitFor(`document.querySelector('[aria-label="Search branches"]')`)
      await search('not-a-real-branch')
      await waitFor(`document.querySelector('.gh-branch-result-count').textContent==='No matching branches'`)
      await escape()
      await waitFor(`!document.querySelector('.gh-branch-picker')`)
      assert.equal(await evaluate('window.closeCount'), 0)
      window.setSize(440, 780)
      await waitFor(`window.innerWidth<500`)
      assert.equal(await evaluate(`document.querySelector('.gh-branch-row').scrollWidth<=document.querySelector('.gh-branch-row').clientWidth+1`), true)
      await click('[aria-label="Find a branch"]')
      await waitFor(`document.querySelector('.gh-branch-picker')`)
      assert.equal(await evaluate(`{
        const menu=document.querySelector('.gh-branch-picker').getBoundingClientRect(), modal=document.querySelector('.git-history-modal').getBoundingClientRect();
        menu.left>=modal.left && menu.right<=modal.right
      }`), true)
      await search('/249-')
      await waitFor(`document.querySelectorAll('.gh-branch-results [role="option"]').length===1`)
      await waitFor(`Number(getComputedStyle(document.querySelector('.gh-branch-picker')).opacity)>0.99`)
      if (process.env.PANEPILOT_UI_SCREENSHOT) await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
      await escape()
      await waitFor(`!document.querySelector('.gh-branch-picker')`)
      await click('[aria-label="Find a branch"]')
      await waitFor(`document.querySelector('.gh-branch-picker')`)
      await click('.gh-all-branches')
      await waitFor(`window.gitRequests.at(-1)===null && document.querySelector('.gh-all-branches').getAttribute('aria-pressed')==='true' && !document.querySelector('.gh-branch-picker')`)
      window.setSize(1150, 780)
      await evaluate(`window.showDenseHistory()`)
      await waitFor(`document.querySelector('.gh-viewport.dense') && document.querySelectorAll('.gh-node').length>1`)
      assert.equal(await evaluate(timestampsBelowHashes), true, 'Dense branch slices keep timestamps beneath their hashes')
      if (process.env.PANEPILOT_GIT_TIME_SCREENSHOT) await writeFile(`${process.env.PANEPILOT_GIT_TIME_SCREENSHOT}.dense.png`, (await window.webContents.capturePage()).toPNG())
      await escape()
      await waitFor('window.closeCount===1')
      process.stdout.write('Git UI passed: timestamps beneath hashes in normal/dense slices, selection without copying, explicit SHA copy, 251-branch overflow, searchable offscreen refs, narrow layout, and nested Escape.\n')
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
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {GitHistoryModal} from './src/renderer/src/components/GitHistoryModal';
    const hash=n=>n.toString(16).padStart(40,'0');
    const commits=Array.from({length:20},(_,i)=>{const n=20-i;return {hash:hash(n),shortHash:hash(n).slice(-7),parents:n>1?[hash(n-1)]:[],decorations:[],author:'UI fixture',authoredAt:'2026-10-18T12:00:00Z',subject:'Commit '+n,graph:'*'};});
    const branches=[{name:'main',hash:hash(20),remote:false},...Array.from({length:250},(_,i)=>({name:(i<125?'feature/':'origin/feature/')+i+'-a-long-branch-name-for-the-overflow-check',hash:hash(i%20+1),remote:i>=125}))];
    const sides=Array.from({length:18},(_,i)=>({...commits[0],hash:hash(i+3),shortHash:hash(i+3).slice(-7),parents:[hash(1)],subject:'Branch '+i}));
    const denseCommits=[{...commits[0],hash:hash(21),shortHash:hash(21).slice(-7),parents:[hash(2),...sides.map(c=>c.hash)],subject:'Merge branches'},...sides.reverse(),commits.at(-2),commits.at(-1)];
    const denseBranches=[{name:'main',hash:hash(21),remote:false},...sides.map((c,i)=>({name:'feature/'+i,hash:c.hash,remote:false}))];
    window.copies=[];window.gitRequests=[];window.closeCount=0;window.targetBranch=branches.at(-1);
    window.projectConsole={git:{branches:async(project)=>project==='dense'?denseBranches:branches,commits:async(project,offset,limit,tip)=>{window.gitRequests.push(tip??null);const all=project==='dense'?denseCommits:commits;const history=tip?all.filter(c=>parseInt(c.hash,16)<=parseInt(tip,16)):all;return {commits:history,offset:0,total:history.length,hasMore:false};}},system:{copyText:async text=>{window.copies.push(text);}},projects:{openRepository:async()=>{}}};
    const status={isRepository:true,root:'/fixture',originUrl:'https://github.com/example/fixture.git',branch:'main',detached:false,head:hash(20),upstream:null,ahead:0,behind:0,stashCount:0,clean:true,changes:[],message:null,refreshedAt:'2026-10-18T12:00:00Z'};
    function Harness(){const[open,setOpen]=useState(true);const[project,setProject]=useState('fixture');window.showDenseHistory=()=>setProject('dense');return <GitHistoryModal open={open} projectId={project} projectName="Crowded repository" repositoryUrl={status.originUrl} status={{...status,head:project==='dense'?hash(21):status.head}} onRefreshStatus={async()=>{}} onClose={()=>{window.closeCount++;setOpen(false);}}/>;}
    createRoot(document.getElementById('root')).render(<Harness/>);
  `
}
