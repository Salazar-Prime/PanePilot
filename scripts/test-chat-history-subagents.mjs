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
  const temp = await mkdtemp(join(tmpdir(), 'panepilot-subagent-ui-'))
  try {
    await build({
      stdin: { contents: fixture(), loader: 'tsx', resolveDir: root },
      bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
      alias: { '@shared': join(root, 'src/shared') }, outfile: join(temp, 'fixture.js')
    })
    const electron = createRequire(import.meta.url)('electron')
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const code = await new Promise((done, reject) => {
      const child = spawn(electron, [script, temp], { env, stdio: 'inherit' })
      child.once('error', reject)
      child.once('exit', done)
    })
    if (code !== 0) process.exitCode = 1
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const temp = process.argv[2]
  app.setPath('userData', join(temp, 'profile'))
  process.stdout.write('Starting isolated chat-history window…\n')
  setTimeout(() => { process.stderr.write('UI smoke test timed out.\n'); app.exit(1) }, 25_000).unref()
  // Electron emits Ready after its ESM entry finishes evaluating. Do not await
  // that event at module scope: it would hold startup open indefinitely.
  void app.whenReady().then(async () => {
  process.stdout.write('Isolated Electron ready.\n')
  const window = new BrowserWindow({ width: 1200, height: 800, show: false, webPreferences: { backgroundThrottling: false, sandbox: true } })
  const evaluate = (code) => window.webContents.executeJavaScript(code)
  const waitFor = async (code) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code)) return
      await new Promise((done) => setTimeout(done, 50))
    }
    throw new Error(`UI did not settle: ${code}`)
  }
  const click = (label) => evaluate(`document.querySelector('[aria-label=${JSON.stringify(label)}]').click()`)
  try {
    const css = await readFile(join(root, 'src/renderer/src/styles.css'), 'utf8')
    const html = `<html><head><style>${css}body,#root{height:100vh;margin:0}#root{display:flex}</style></head><body><div id="root"></div></body></html>`
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    process.stdout.write('Fixture loaded.\n')
    await evaluate(await readFile(join(temp, 'fixture.js'), 'utf8'))
    process.stdout.write('Chat-history mounted.\n')
    await waitFor(`document.querySelectorAll('.chat-conversation-card').length === 2 && document.querySelector('.chat-messages')`)
    assert.equal(await evaluate(`document.querySelector('.chat-detail-summary strong').textContent`), 'Main task')
    await click('Expand 3 subagents for Main task')
    await waitFor(`document.querySelectorAll('.chat-conversation-card').length === 4`)
    await evaluate(`Array.from(document.querySelectorAll('.chat-conversation-card')).find(el=>el.textContent.includes('Reviewer')).click()`)
    await waitFor(`document.querySelector('.chat-messages').textContent.includes('Review result')`)
    assert.equal(await evaluate(`document.querySelector('.chat-parent-navigation button').textContent`), '← Main task')
    await evaluate(`document.querySelector('.chat-detail-copy-button').click()`)
    await waitFor(`window.copied === 'reviewer'`)
    await click('Expand 1 subagent for Reviewer')
    await waitFor(`document.querySelectorAll('.chat-conversation-card').length === 5`)
    await click('Collapse 3 subagents for Main task')
    await waitFor(`document.querySelectorAll('.chat-conversation-card').length === 2`)
    await evaluate(`{
      const input=document.querySelector('.chat-search input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'needle');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }`)
    await waitFor(`document.querySelectorAll('.chat-conversation-card').length === 3 && document.querySelector('.chat-messages').textContent.includes('Needle found')`)
    assert.equal(await evaluate(`document.querySelectorAll('.chat-subagent-toggle[aria-expanded="true"]').length`), 2)
    assert.equal(await evaluate(`document.querySelector('.chat-detail-summary strong').textContent`), 'Find needle')
    await evaluate(`{
      const input=document.querySelector('.chat-search input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }`)
    await waitFor(`document.querySelectorAll('.chat-conversation-card').length === 5`)
    await evaluate(`Array.from(document.querySelectorAll('.chat-conversation-card')).find(el=>el.textContent.includes('Main task')).click()`)
    await waitFor(`document.querySelectorAll('.chat-message').length === 6`)
    assert.equal(await evaluate(`document.querySelector('.chat-message-counter span').textContent`), '6 messages')
    assert.equal(await evaluate(`Array.from(document.querySelectorAll('button')).some(el=>el.textContent==='Show all')`), false)
    await click('Next user message')
    await waitFor(`document.querySelector('.chat-message.navigation-target')?.dataset.messageId === 'root-u2' && document.querySelector('.chat-messages').scrollTop > 0`)
    await click('Next user message')
    await waitFor(`document.querySelector('.chat-message.navigation-target')?.dataset.messageId === 'root-u3'`)
    assert.equal(await evaluate(`document.querySelector('[aria-label="Next user message"]').disabled`), true)
    await click('Previous user message')
    await waitFor(`document.querySelector('.chat-message.navigation-target')?.dataset.messageId === 'root-u2'`)
    await evaluate(`{
      const input=document.querySelector('.chat-message-counter input');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'1');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    }`)
    await waitFor(`document.querySelectorAll('.chat-message').length === 5 && !Array.from(document.querySelectorAll('.chat-conversation-card strong')).some(el=>el.textContent==='Main task')`)
    await evaluate(`Array.from(document.querySelectorAll('.chat-conversation-card')).find(el=>el.textContent.includes('Reviewer')).click()`)
    await waitFor(`document.querySelectorAll('.chat-message').length === 1 && document.querySelector('.chat-message-counter input').value==='1'`)
    await evaluate(`window.remountChat()`)
    await waitFor(`document.querySelectorAll('.chat-message').length === 5 && document.querySelector('.chat-message-counter input').value==='1'`)
    if (process.env.PANEPILOT_UI_SCREENSHOT) {
      await writeFile(process.env.PANEPILOT_UI_SCREENSHOT, (await window.webContents.capturePage()).toPNG())
    }
    process.stdout.write('Chat UI passed: subagent hierarchy/search, user-turn navigation, total counts, global sidebar trimming, and session retention after remount.\n')
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
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {ChatHistoryPanel} from './src/renderer/src/components/ChatHistoryPanel';
    import {matchingConversations} from './src/shared/conversation-hierarchy';
    import {conversationDisplayWindow} from './src/shared/conversation-messages';
    const make=(id,parent,title,content,agentName=null)=>({id,provider:'codex',providerSessionId:id,parentProviderSessionId:parent,agentName,title,
      workingDirectory:'/project',updatedAt:'2026-10-18T10:00:00Z',messageCount:2,snippet:content,matchCount:0,
      messages:[{id:id+'-u',role:'user',content:title,timestamp:null},{id:id+'-a',role:'assistant',content,timestamp:null}]});
    const chats=[make('nested','reviewer','Find needle','Needle found'),make('reviewer','root','Review tests','Review result','Reviewer'),
      make('worker','root','Implement change','Change done','Builder'),make('root',null,'Main task','Main result'),make('other',null,'Unrelated chat','Other result')];
    chats.find(c=>c.id==='root').messages.push({id:'root-u2',role:'user',content:'Second user turn',timestamp:null},
      {id:'root-a2',role:'assistant',content:'Second answer',timestamp:null},
      {id:'root-u3',role:'user',content:'Third user turn',timestamp:null},
      {id:'root-a3',role:'assistant',content:'Third answer',timestamp:null});
    chats.find(c=>c.id==='root').messages[1].content=('Main result line\\n').repeat(24);
    for(const chat of chats)chat.messageCount=chat.messages.length;
    window.projectConsole={conversations:{
      list:async (_project,query,hiddenCount)=>{const items=chats.map(c=>{const display=conversationDisplayWindow(c,hiddenCount);return {...c,title:display.title,snippet:display.messages.at(-1)?.content??'',matchCount:query&&JSON.stringify(c.messages).toLowerCase().includes(query.toLowerCase())?1:0};});return query?matchingConversations(items):items;},
      get:async (_project,id)=>chats.find(c=>c.id===id)
    },system:{copyText:async text=>{window.copied=text;}}};
    const root=createRoot(document.getElementById('root'));let revision=0;
    window.remountChat=()=>root.render(<ChatHistoryPanel key={++revision} project={{id:'fixture',folder:'/project'}}/>);
    root.render(<ChatHistoryPanel key={revision} project={{id:'fixture',folder:'/project'}}/>);
  `
}
