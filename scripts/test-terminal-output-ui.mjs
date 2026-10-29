import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Actual ManagedTerminal and xterm parsers with delayed parse callbacks. Only
// the IPC producer is synthetic; no user terminal or workspace is opened.
const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-terminal-output-ui-'))
  try {
    await build({
      stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      define: { 'import.meta.env.DEV': 'false' },
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js')
    })
    const css = await readFile(join(root, 'node_modules/@xterm/xterm/css/xterm.css'), 'utf8')
    await writeFile(join(temp, 'index.html'), `<html><head><style>${css}
      body{margin:0}.managed-terminal,.terminal-host{height:320px;width:700px}
      </style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(createRequire(import.meta.url)('electron'), [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', done)
    })
    if (code !== 0) process.exitCode = 1
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  setTimeout(() => { process.stderr.write('Terminal output test timed out.\n'); app.exit(1) }, 30_000).unref()
  void app.whenReady().then(async () => {
    if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
    const window = new BrowserWindow({ width: 800, height: 700, show: false,
      webPreferences: { backgroundThrottling: false, sandbox: true } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(code)) return
        await new Promise((done) => setTimeout(done, 20))
      }
      throw new Error(`UI did not settle: ${code}`)
    }
    try {
      await window.loadFile(join(temp, 'index.html'))
      await waitFor('window.callbacks.length===2')
      assert.equal(await evaluate('window.acks.length'), 0, 'Replay remains charged until parsing completes')
      await evaluate(`window.send('LIVE_ONE\\r\\n\\x1b]52;c;Y2xpcGJvYXJkLWFjdGl2ZQ==\\x07');window.release(0)`)
      assert.equal(await evaluate('window.writes.length'), 2, 'One ready split pane must not bypass the other replay')
      await evaluate('window.release(1)')
      await waitFor('window.callbacks.length===2 && window.writes.length===4')
      assert.deepEqual(await evaluate('window.acks.map(ack=>ack.sequence)'), [0, 0])
      assert.deepEqual(await evaluate('window.copies'), ['clipboard-active'], 'Hidden surfaces never process OSC52 into the clipboard')
      assert.deepEqual(await evaluate('window.buffers()'), ['REPLAY\nLIVE_ONE', 'REPLAY\nLIVE_ONE'])
      await evaluate(`window.send('LIVE_TWO\\r\\n');window.release(0)`)
      assert.equal(await evaluate('window.writes.length'), 4, 'Slow hidden xterm still owns its live output credit')
      await evaluate('window.changeCount(1)')
      await waitFor('window.consumers.size===1 && window.writes.length===5 && window.callbacks.length===2')
      assert.equal(await evaluate('window.unsubscribes.length'), 1, 'Evicting the slow surface releases its producer barrier')
      await evaluate('window.release(1);window.release(0)')
      assert.deepEqual(await evaluate('window.acks.map(ack=>ack.sequence)'), [0, 0, 1, 2],
        'Disposed xterm callback must not acknowledge its old generation')
      assert.deepEqual(await evaluate('window.buffers()'), ['REPLAY\nLIVE_ONE\nLIVE_TWO'])

      await evaluate(`window.send('LAST\\r\\n')`)
      await waitFor('window.callbacks.length===1')
      const beforeDisposeAcks = await evaluate('window.acks.length')
      await evaluate('window.changeCount(0)')
      await waitFor('window.consumers.size===0 && window.listeners.size===0')
      await evaluate('window.release(0)')
      assert.equal(await evaluate('window.acks.length'), beforeDisposeAcks)

      const beforeLateWrites = await evaluate('window.writes.length')
      await evaluate('window.delayAttach=true;window.changeCount(1)')
      await waitFor('window.pendingAttaches.length===1')
      await evaluate('window.changeCount(0)')
      await waitFor('window.listeners.size===0')
      await evaluate('window.pendingAttaches.shift()()')
      await waitFor('window.consumers.size===0')
      assert.equal(await evaluate('window.writes.length'), beforeLateWrites, 'Late replay cannot write into an unmounted terminal')
      assert.deepEqual(await evaluate('window.errors'), [])
      process.stdout.write('Terminal output UI passed: real xterm replay ordering, delayed parse credits, split-pane and hidden-surface credits, raw OSC52 behavior, eviction release, stale callbacks, and late-attach cleanup.\n')
      window.destroy()
      app.exit(0)
    } catch (error) {
      process.stderr.write(`${error.stack ?? error}\n`)
      process.stderr.write(`${JSON.stringify(await evaluate('window.errors').catch(() => []))}\n`)
      window.destroy()
      app.exit(1)
    }
  })
}

function fixture() {
  return `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {Terminal} from '@xterm/xterm';
    import {ManagedTerminal} from './src/renderer/src/components/ManagedTerminal';
    window.errors=[];
    window.addEventListener('error',event=>window.errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>window.errors.push(String(event.reason)));
    window.listeners=new Set();window.consumers=new Map();window.acks=[];window.unsubscribes=[];
    window.writes=[];window.callbacks=[];window.copies=[];window.pendingAttaches=[];window.delayAttach=false;
    const terminals=new Map();let terminalCounter=0;let pendingData=[];
    const originalWrite=Terminal.prototype.write;const originalDispose=Terminal.prototype.dispose;
    Terminal.prototype.write=function(data,callback){
      if(!this.fixtureId){this.fixtureId=++terminalCounter;terminals.set(this.fixtureId,this)}
      window.writes.push({terminal:this.fixtureId,data});
      return originalWrite.call(this,data,()=>{if(callback)window.callbacks.push({terminal:this.fixtureId,callback})});
    };
    Terminal.prototype.dispose=function(){terminals.delete(this.fixtureId);return originalDispose.call(this)};
    window.release=(surface)=>{
      const index=window.callbacks.findIndex(entry=>entry.terminal===surface+1);
      if(index<0)throw new Error('No held callback for surface '+surface);
      window.callbacks.splice(index,1)[0].callback();
    };
    window.buffers=()=>Array.from(terminals.values(),terminal=>{
      const buffer=terminal.buffer.active;
      return Array.from({length:buffer.length},(_,i)=>buffer.getLine(i).translateToString(true)).join('\\n').trim();
    });
    const flush=()=>{
      if(!window.consumers.size){pendingData=[];return}
      const consumers=Array.from(window.consumers.values());
      if(!pendingData.length||consumers.some(consumer=>consumer.acked!==consumer.sent))return;
      const data=pendingData.shift();
      for(const consumer of consumers){
        consumer.sent++;
        const event={sessionId:'same-session',consumerId:consumer.id,generation:consumer.generation,sequence:consumer.sent,data};
        for(const listener of window.listeners)listener(event);
      }
    };
    window.send=(data)=>{pendingData.push(data);flush()};
    window.projectConsole={
      terminals:{
        attach:async(id,cols,rows,consumerId)=>{
          const attach=()=>{
            const generation=consumerId+'-generation';
            window.consumers.set(consumerId,{id:consumerId,generation,acked:-1,sent:0});
            return {output:'REPLAY\\r\\n',generation,sequence:0};
          };
          if(window.delayAttach)return new Promise(resolve=>window.pendingAttaches.push(()=>resolve(attach())));
          return attach();
        },
        acknowledgeOutput:(id,consumerId,generation,sequence)=>{
          const consumer=window.consumers.get(consumerId);
          if(!consumer||consumer.generation!==generation)return;
          window.acks.push({consumerId,generation,sequence});consumer.acked=sequence;flush();
        },
        unsubscribeOutput:(id,consumerId)=>{window.unsubscribes.push(consumerId);window.consumers.delete(consumerId);flush()},
        onData:(listener)=>{window.listeners.add(listener);return()=>window.listeners.delete(listener)},
        onTransport:()=>()=>{},resize:async()=>{},write:async()=>{}
      },
      system:{copyText:async(text)=>{window.copies.push(text)},openExternal:async()=>{}}
    };
    const session={id:'same-session',projectId:'fixture',kind:'terminal',name:'Fixture',profile:'shell',backend:'tmux',
      tmuxName:'fixture',state:'idle',archived:false,pinned:false,flagged:false,dangerousMode:false,output:'',latexChat:null,
      providerSessionId:null,providerSessionName:null,customCommand:null,createdAt:'2026-01-01',updatedAt:'2026-01-01'};
    function Fixture(){
      const [count,setCount]=useState(2);window.changeCount=setCount;
      return <>{Array.from({length:count},(_,index)=><div key={index} style={index?{display:'none'}:{}}>
        <ManagedTerminal session={session} active={index===0}/></div>)}</>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `
}
