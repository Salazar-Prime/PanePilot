import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url), root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-tab-title-ui-'))
  try {
    await build({ stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js') })
    const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${css}
      html,body{margin:0;height:100%}#outer{height:680px;overflow:auto;padding:18px}
      #spacer{height:140px}#strips{display:flex;flex-direction:column;gap:32px}
      .fixture-strip{max-width:100%}.fixture-strip h3{font-size:12px;color:#aaa;margin:0 0 8px}
      #tail{height:700px}.terminal-tabs{width:100%}
    </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject); child.once('exit', done)
    })
    if (code !== 0) process.exitCode = 1
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  setTimeout(() => app.exit(1), 40_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 1500, height: 800, show: false,
      webPreferences: { sandbox: true, backgroundThrottling: false } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const pause = (ms) => new Promise((done) => setTimeout(done, ms))
    const settle = async () => { await evaluate('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))'); await pause(30) }
    const metrics = () => evaluate(`['terminal','files'].map(kind=>{
      const root=document.querySelector('[data-kind="'+kind+'"]');
      const strip=root.querySelector('[data-strip]'),sr=strip.getBoundingClientRect();
      return {kind,width:strip.clientWidth,scrollWidth:strip.scrollWidth,scrollLeft:strip.scrollLeft,
        height:strip.clientHeight,tabs:[...strip.querySelectorAll('[data-active-tab]')].map(tab=>{
          const name=tab.querySelector('[data-title]'),r=tab.getBoundingClientRect();
          return {active:tab.dataset.activeTab==='true',width:r.width,nameWidth:name.clientWidth,
            nameScroll:name.scrollWidth,nameHeight:name.clientHeight,nameScrollHeight:name.scrollHeight,
            left:r.left-sr.left,right:r.right-sr.left,text:name.textContent,
            controlVisible:[...tab.querySelectorAll('button')].every(b=>b.getBoundingClientRect().width>=15)}
        })}
    })`)
    try {
      await window.loadFile(join(temp, 'index.html'))
      await settle()
      await evaluate('document.getElementById("outer").scrollTop=100')
      await settle()
      for (const strip of await metrics()) {
        assert.ok(strip.tabs.some((tab) => tab.width > 230), `${strip.kind}: no fixed width cap`)
        assert.ok(strip.tabs.every((tab) => tab.nameScroll <= tab.nameWidth + 1), `${strip.kind}: all titles fit with spare room`)
        assert.ok(strip.scrollWidth <= strip.width + 1, `${strip.kind}: no needless scroll when titles fit`)
      }
      await evaluate('window.tabFixture.configure({width:650,active:1})'); await settle()
      for (const strip of await metrics()) {
        assert.ok(strip.tabs.filter((tab) => !tab.active).some((tab) => tab.nameScroll > tab.nameWidth + 1), `${strip.kind}: only crowded inactive names truncate`)
        const active = strip.tabs.find((tab) => tab.active)
        assert.ok(active.nameScroll <= active.nameWidth + 1, `${strip.kind}: active name stays complete`)
        assert.ok(active.controlVisible, `${strip.kind}: controls retain usable width`)
      }
      await evaluate('window.tabFixture.configure({width:650,count:14,active:13})'); await settle()
      for (const strip of await metrics()) {
        const active = strip.tabs.find((tab) => tab.active)
        assert.ok(strip.scrollWidth > strip.width && strip.scrollLeft > 0, `${strip.kind}: overflow remains scrollable`)
        assert.ok(active.left >= -1 && active.right <= strip.width + 1, `${strip.kind}: selected last tab fully revealed`)
        assert.ok(active.nameScroll <= active.nameWidth + 1, `${strip.kind}: selected title never truncated`)
      }
      assert.equal(await evaluate('document.getElementById("outer").scrollTop'), 100, 'Revealing a tab never moves the outer workspace')
      await evaluate('window.tabFixture.configure({active:0})'); await settle()
      for (const strip of await metrics()) assert.ok(strip.tabs[0].left >= -1, `${strip.kind}: first selection revealed`)
      await evaluate('window.tabFixture.configure({width:280,count:3,active:1,long:true})'); await settle()
      for (const strip of await metrics()) {
        const active = strip.tabs.find((tab) => tab.active)
        assert.ok(active.nameHeight > 20, `${strip.kind}: pane-wide unbroken name wraps`)
        assert.ok(active.nameScroll <= active.nameWidth + 1 && active.nameScrollHeight <= active.nameHeight + 1, `${strip.kind}: all active characters remain visible`)
        assert.ok(active.left >= -1 && active.right <= strip.width + 1, `${strip.kind}: wrapped tab remains inside its own viewport`)
      }
      await evaluate('window.tabFixture.configure({width:1300,count:3,active:1,long:false})'); await settle()
      for (const strip of await metrics()) {
        assert.ok(strip.tabs.every((tab) => tab.nameScroll <= tab.nameWidth + 1), `${strip.kind}: growing restores all full titles`)
        assert.ok(strip.height <= 40, `${strip.kind}: ordinary names preserve compact bar height`)
      }
      await evaluate('window.tabFixture.configure({width:650,count:14,active:13})'); await settle()
      await evaluate('window.tabFixture.configure({width:440})'); await settle()
      for (const strip of await metrics()) {
        const active = strip.tabs.find((tab) => tab.active)
        assert.ok(active.left >= -1 && active.right <= strip.width + 1, `${strip.kind}: resize preserves selected visibility`)
      }
      process.stdout.write('Tab titles passed: natural widths, active-title priority, inactive ellipsis only when crowded, overflow reveal, long-title wrapping, resize recovery, stable compact height, and no workspace scrolling.\n')
      window.destroy(); app.exit(0)
    } catch (cause) {
      process.stderr.write(`${cause.stack ?? cause}\n`)
      process.stderr.write(`${JSON.stringify(await metrics())}\n`)
      window.destroy(); app.exit(1)
    }
  })
}

function fixture() {
  return `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import {MoreHorizontal,Pin,X,FileCode2} from 'lucide-react';
    import {StatusDot} from './src/renderer/src/components/StatusDot';
    import {TerminalProfileIcon} from './src/renderer/src/components/TerminalProfileIcon';
    import {useActiveTabVisibility} from './src/renderer/src/lib/useActiveTabVisibility';
    const titles=['Review the public release documentation','Update SSH project discovery and reconnect behavior','Fix responsive LaTeX PDF navigation'];
    function Strip({kind,state}){
      const names=Array.from({length:state.count},(_,i)=>state.long&&i===state.active?'W'.repeat(120):titles[i%3]+(i>=3?' '+i:''));
      const ref=useActiveTabVisibility(String(state.active),JSON.stringify(names));
      const tabs=names.map((name,i)=>{const active=i===state.active;
        if(kind==='terminal')return <div key={i} data-active-tab={active} className={'terminal-tab '+(active?'active':'')}>
          <button className="terminal-tab-select" onClick={()=>window.tabFixture.configure({active:i})}><StatusDot state="response-ready" compact/><TerminalProfileIcon profile="codex"/><Pin size={10}/><span data-title>{name}</span></button>
          <button className="tab-menu-button" aria-label="Actions"><MoreHorizontal size={14}/></button><button className="tab-close-button" aria-label="Close"><X size={13}/></button></div>;
        return <div key={i} data-active-tab={active} className={'file-preview-tab '+(active?'selected':'')}>
          <button className="file-preview-tab-select" onClick={()=>window.tabFixture.configure({active:i})}><FileCode2 size={13}/><span data-title>{name}</span><i aria-label="Unsaved changes"/></button><button className="file-preview-tab-close"><X size={12}/></button></div>
      });
      return <section className="fixture-strip" data-kind={kind} style={{width:state.width}}><h3>{kind==='terminal'?'Project terminals':'Files'}</h3>{kind==='terminal'?<div className="terminal-tabs"><div data-strip className="terminal-tabs-scroll" ref={ref}>{tabs}</div></div>:<div data-strip className="file-preview-tabs" ref={ref}>{tabs}</div>}</section>
    }
    function Fixture(){const [state,setState]=useState({width:1300,count:3,active:1,long:false});window.tabFixture={configure:next=>setState(old=>({...old,...next}))};return <div id="outer"><div id="spacer"/><div id="strips">{['terminal','files'].map(kind=><Strip key={kind} kind={kind} state={state}/>)}</div><div id="tail"/></div>}
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `
}
