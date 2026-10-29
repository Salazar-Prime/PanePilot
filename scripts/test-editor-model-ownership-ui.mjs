// Actual Monaco and the production ManagedEditor, isolated Electron profile,
// synthetic documents only. This is a functional regression check, not timing.
// Usage: node scripts/test-editor-model-ownership-ui.mjs [report.json]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(import.meta.url)
const root = resolve(dirname(script), '..')
const delay = (ms) => new Promise((done) => setTimeout(done, ms))
if (!process.versions.electron) {
  // Keeping the temporary fixture below the repository lets Vite resolve the
  // exact installed React/Monaco dependencies without another package install.
  const temp = await mkdtemp(join(root, '.editor-model-fixture-'))
  const report = process.argv[2] ? resolve(process.argv[2]) : ''
  try {
    await writeFile(join(temp, 'fixture.tsx'), fixture())
    await writeFile(join(temp, 'index.html'), '<html><head><meta charset="UTF-8"><style>html,body,#root{height:100%;margin:0}#root{display:flex}.pane{height:100%;min-width:0;flex:1}</style></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>')
    const { build } = await import('vite')
    await build({ configFile: false, root: temp, base: './', logLevel: 'warn',
      define: { 'process.env.NODE_ENV': '"production"' },
      esbuild: { jsx: 'automatic' },
      build: { outDir: join(temp, 'dist'), chunkSizeWarningLimit: 10000 }
    })
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const electron = createRequire(import.meta.url)('electron')
    process.exitCode = await new Promise((done, reject) => {
      const child = spawn(electron, [script, temp, report], { env, stdio: 'inherit' })
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Editor ownership fixture timed out after 90 seconds.')) }, 90_000)
      child.once('error', (error) => { clearTimeout(timeout); reject(error) })
      child.once('exit', (status) => { clearTimeout(timeout); done(status ?? 1) })
    })
  } finally { await rm(temp, { recursive: true, force: true }) }
} else {
  const { app, BrowserWindow } = await import('electron')
  const [temp, output] = process.argv.slice(2)
  app.setPath('userData', join(temp, 'profile'))
  app.setPath('sessionData', join(temp, 'session'))
  if (process.platform === 'darwin') app.setActivationPolicy('prohibited')
  app.on('window-all-closed', () => {})
  void app.whenReady().then(async () => {
    const window = new BrowserWindow({ width: 1200, height: 800, show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    const evaluate = (code) => window.webContents.executeJavaScript(code)
    const logs = [], blockedRequests = [], failedRequests = []
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error') logs.push(event.message)
    })
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      const allowed = ['file:', 'data:', 'blob:', 'about:'].includes(new URL(details.url).protocol)
      if (!allowed) blockedRequests.push(details.url)
      callback({ cancel: !allowed })
    })
    window.webContents.session.webRequest.onErrorOccurred((details) => failedRequests.push({ url: details.url, error: details.error }))
    const waitFor = async (condition) => {
      for (let attempt = 0; attempt < 300; attempt++) {
        if (await evaluate(condition)) return
        await delay(20)
      }
      throw new Error(`Editor ownership fixture did not settle: ${condition}`)
    }
    const paint = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    const show = async (rows) => {
      await evaluate(`window.fixture.show(${JSON.stringify(rows)})`)
      await waitFor(`window.fixture.ready(${JSON.stringify(rows.map(({ slot, path }) => ({ slot, path })))})`)
      await paint()
    }
    try {
      await window.loadFile(join(temp, 'dist/index.html'))
      await waitFor('!!window.fixture')
      const clean = (index) => `panepilot-files/synthetic/clean-${index}.txt`
      await show([{ slot: 'left', path: clean(0), saved: 'Clean 0' }])
      await evaluate('void (window.firstClean = window.fixture.model("left"))')
      for (let index = 1; index <= 40; index++) {
        await show([{ slot: 'left', path: clean(index), saved: `Clean ${index}` }])
      }
      assert.equal(await evaluate('window.firstClean.isDisposed()'), true, 'The oldest unowned clean model must be evicted')
      const cleanModelCount = await evaluate('window.fixture.models().length')
      assert.ok(cleanModelCount <= 33, `At most 32 retained clean models plus one live model, got ${cleanModelCount}`)

      const refreshedPath = 'panepilot-files/synthetic/refreshed.txt'
      await show([{ slot: 'left', path: refreshedPath, saved: 'Old saved content' }])
      await evaluate('void (window.refreshedModel = window.fixture.model("left"))')
      await show([])
      await evaluate('window.fixture.changes.length = 0')
      await show([{ slot: 'left', path: refreshedPath, saved: 'New saved content', value: 'New saved content' }])
      assert.equal(await evaluate('window.fixture.model("left") === window.refreshedModel'), true, 'A retained clean model is reused')
      assert.equal(await evaluate('window.fixture.editor("left").getValue()'), 'New saved content', 'Fresh saved content replaces the retained clean snapshot')
      assert.equal(await evaluate('window.fixture.rows()[0].value'), 'New saved content')
      assert.equal(await evaluate('window.fixture.changes.some(change => change.path === "panepilot-files/synthetic/refreshed.txt" && change.value === "Old saved content")'), false, 'Mounting a stale clean model cannot publish its old text as a new dirty draft')
      await show([{ slot: 'left', path: refreshedPath, saved: 'New saved content', value: 'New saved content' }, { slot: 'right', path: refreshedPath, saved: 'Old saved content', value: 'Old saved content' }])
      assert.equal(await evaluate('window.fixture.editor("left").getValue()'), 'New saved content', 'A stale split mount cannot overwrite a live clean model saved by another pane')
      await waitFor('window.fixture.rows().every(row => row.value === "New saved content")')

      const dirtyPath = 'panepilot-latex/synthetic/draft.tex'
      const original = Array.from({ length: 500 }, (_, index) => `Line ${index + 1}: ${'source text '.repeat(40)}`).join('\n')
      await show([{ slot: 'left', path: dirtyPath, saved: original }])
      await evaluate(`(() => {
        const editor=window.fixture.editor('left'); window.dirtyModel=editor.getModel();
        editor.pushUndoStop(); editor.executeEdits('fixture', [{range:{startLineNumber:2,startColumn:1,endLineNumber:2,endColumn:1},text:'UNSAVED DRAFT ',forceMoveMarkers:true}]); editor.pushUndoStop();
      })()`)
      await waitFor('window.fixture.editor("left").getValue().includes("UNSAVED DRAFT")')
      await paint()
      await evaluate(`window.fixture.editor('left').setSelection({startLineNumber:200,startColumn:60,endLineNumber:201,endColumn:65})`)
      await paint()
      await evaluate(`window.fixture.editor('left').setScrollPosition({scrollTop:3200,scrollLeft:240}, 1)`)
      await waitFor('window.fixture.editor("left").getScrollTop()>0 && window.fixture.editor("left").getScrollLeft()>0')
      await paint()
      const savedView = await evaluate('window.fixture.view("left")')
      const dirtyValue = await evaluate('window.fixture.editor("left").getValue()')
      assert.ok(savedView.scrollTop > 0 && savedView.scrollLeft > 0, 'The fixture must test actual vertical and horizontal scrolling')
      for (let index = 41; index <= 81; index++) {
        await show([{ slot: 'left', path: clean(index), saved: `Clean ${index}` }])
      }
      assert.equal(await evaluate('window.dirtyModel.isDisposed()'), false, 'An unowned dirty model survives clean-model churn')
      assert.equal(await evaluate('window.dirtyModel.getValue()'), dirtyValue, 'The unsaved text remains exact')
      const dirtyChurnModelCount = await evaluate('window.fixture.models().length')
      assert.ok(dirtyChurnModelCount <= 34, `Dirty model plus at most 32 clean retained models and one live model, got ${dirtyChurnModelCount}`)
      await show([{ slot: 'left', path: dirtyPath, saved: original }])
      assert.equal(await evaluate('window.fixture.model("left") === window.dirtyModel'), true, 'Remount reuses the dirty Monaco model')
      assert.equal(await evaluate('window.fixture.editor("left").getValue()'), dirtyValue)
      await waitFor(`Math.abs(window.fixture.editor("left").getScrollLeft() - ${savedView.scrollLeft}) <= 1`)
      const restoredView = await evaluate('window.fixture.view("left")')
      assert.deepEqual(restoredView.selection, savedView.selection, 'The exact selection survives remount')
      assert.ok(Math.abs(restoredView.scrollTop - savedView.scrollTop) <= 1, 'Vertical scrolling survives remount')
      const horizontalScrollRestored = Math.abs(restoredView.scrollLeft - savedView.scrollLeft) <= 1
      await evaluate('window.fixture.editor("left").trigger("fixture", "undo", null)')
      await waitFor(`window.fixture.editor('left').getValue() === ${JSON.stringify(original)}`)
      await evaluate('window.fixture.editor("left").trigger("fixture", "redo", null)')
      await waitFor(`window.fixture.editor('left').getValue() === ${JSON.stringify(dirtyValue)}`)

      const sharedPath = 'panepilot-notes/synthetic/shared.md'
      await show([{ slot: 'left', path: sharedPath, saved: 'Shared saved content' }, { slot: 'right', path: sharedPath, saved: 'Shared saved content' }])
      assert.equal(await evaluate('window.fixture.model("left") === window.fixture.model("right")'), true, 'Both panes own the exact same URI model')
      await evaluate(`window.sharedModel=window.fixture.model('right'); window.fixture.editor('left').executeEdits('fixture',[{range:{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:1},text:'LIVE ',forceMoveMarkers:true}])`)
      await waitFor('window.fixture.editor("right").getValue().startsWith("LIVE ")')
      await show([{ slot: 'right', path: sharedPath, saved: 'Shared saved content' }])
      assert.equal(await evaluate('window.sharedModel.isDisposed()'), false, 'Closing one pane must not dispose another live owner’s model')
      assert.equal(await evaluate('window.fixture.editor("right").getValue()'), 'LIVE Shared saved content')
      await evaluate(`window.fixture.forget(${JSON.stringify(sharedPath)})`)
      await show([])
      assert.equal(await evaluate('window.sharedModel.isDisposed()'), false, 'An inactive tab close cannot retire another pane’s dirty model')
      await show([{ slot: 'right', path: sharedPath, saved: 'Shared saved content' }])
      for (let index = 82; index <= 122; index++) {
        await show([{ slot: 'left', path: clean(index), saved: `Clean ${index}` }, { slot: 'right', path: sharedPath, saved: 'Shared saved content' }])
      }
      assert.equal(await evaluate('window.sharedModel.isDisposed()'), false, 'A model still owned by a split pane survives eviction pressure')
      assert.equal(await evaluate('window.fixture.editor("right").getValue()'), 'LIVE Shared saved content')
      // A newly mounted pane may have an older renderer snapshot of this URI.
      await show([{ slot: 'left', path: sharedPath, saved: 'Shared saved content', value: 'Shared saved content' }, { slot: 'right', path: sharedPath, saved: 'Shared saved content' }])
      await waitFor('window.fixture.rows().every(row => row.value === "LIVE Shared saved content")')
      assert.equal(await evaluate('window.fixture.model("left") === window.sharedModel'), true)
      assert.equal(await evaluate('window.sharedModel.getValue()'), 'LIVE Shared saved content', 'A stale mounting pane adopts the live shared draft')
      await show([])
      assert.equal(await evaluate('window.sharedModel.isDisposed()'), false, 'An unmounted dirty draft remains retained')
      assert.ok(horizontalScrollRestored, `Horizontal scrolling survives remount (${savedView.scrollLeft} → ${restoredView.scrollLeft})`)
      const errors = await evaluate('window.fixture.errors')
      assert.deepEqual(errors, [], 'Renderer exceptions')
      assert.deepEqual(logs, [], 'Renderer console errors')
      assert.deepEqual(blockedRequests, [], 'Unexpected network access')
      assert.deepEqual(failedRequests, [], 'Asset load failures')
      const report = {
        passed: true, capturedAt: new Date().toISOString(), electron: process.versions.electron,
        method: 'Production ManagedEditor and actual Monaco bundled by Vite, sandboxed Electron, disposable profile, synthetic documents, no application main process or IPC. Assertions await editor ownership and completed render frames; this is a functional regression check, not a timing benchmark.',
        cleanDocumentsVisited: 124, cleanModelCountAfter41Documents: cleanModelCount,
        modelCountWithOneDirtyDraftAfterFurther41Documents: dirtyChurnModelCount,
        cleanLimit: 32, dirtyDraftSurvived: true, undoRedoSurvivedRemount: true,
        cursorAndScrollSurvivedRemount: true, splitModelOwnershipPreserved: true,
        staleSplitMountPreservedDraft: true, freshSavedValueReplacesCleanSnapshot: true,
        errors, logs, blockedRequests, failedRequests,
        limits: ['Synthetic ownership fixture does not exercise application IPC or disk writes.', 'Dirty and currently owned models intentionally remain outside the clean-model eviction budget.']
      }
      if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n') }
      console.log('Editor model ownership passed: 124 clean paths, bounded eviction, dirty draft preservation, undo/redo and cursor/scroll restoration, split-pane ownership, stale mount adoption and fresh saved text.')
      window.destroy(); app.exit(0)
    } catch (error) {
      console.error(error)
      console.error(JSON.stringify({ logs, blockedRequests, failedRequests, fixture: await evaluate('window.fixture?.diagnostics()').catch(() => null) }, null, 2))
      window.destroy(); app.exit(1)
    }
  })
}

function fixture() {
  return `import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { flushSync } from 'react-dom';
    import { Editor, monaco, forgetEditorModel } from '../src/renderer/src/lib/monaco';
    const errors=[]; addEventListener('error',event=>errors.push(event.message));
    addEventListener('unhandledrejection',event=>errors.push(String(event.reason)));
    const editors=new Map(); const values=new Map(); const changes=[]; let rows=[]; let update;
    function Fixture(){
      const [state,setState]=useState([]); update=setState; rows=state;
      return <>{state.map(row=><div className="pane" key={row.slot}><Editor path={row.path} savedValue={row.saved} value={row.value} language="plaintext" height="100%"
        options={{minimap:{enabled:false},wordWrap:'off',scrollBeyondLastLine:false,smoothScrolling:false,fontSize:14,automaticLayout:true}}
        onMount={(editor)=>{editors.set(row.slot,editor);editor.onDidDispose(()=>{if(editors.get(row.slot)===editor)editors.delete(row.slot)})}}
        onChange={(value)=>{changes.push({path:row.path,value});values.set(row.path,value??'');setState(current=>current.map(other=>other.path===row.path?{...other,value:value??''}:other))}}
      /></div>)}</>;
    }
    const root=createRoot(document.getElementById('root')); flushSync(()=>root.render(<Fixture/>));
    window.fixture={errors,changes,forget:forgetEditorModel,
      show(input){flushSync(()=>update(input.map(row=>({...row,value:row.value??values.get(row.path)??row.saved}))))},
      ready(expected){return editors.size===expected.length&&expected.every(row=>editors.get(row.slot)?.getModel()?.uri.toString()===monaco.Uri.parse(row.path).toString())},
      editor(slot){return editors.get(slot)},model(slot){return editors.get(slot).getModel()},models(){return monaco.editor.getModels()},rows(){return rows},
      view(slot){const editor=editors.get(slot);return {selection:editor.getSelection(),scrollTop:editor.getScrollTop(),scrollLeft:editor.getScrollLeft()}},
      diagnostics(){return {errors,rows:rows.map(row=>({slot:row.slot,path:row.path})),models:monaco.editor.getModels().map(model=>({uri:model.uri.toString(),length:model.getValueLength()})),editors:[...editors].map(([slot,editor])=>({slot,uri:editor.getModel()?.uri.toString()}))}}
    };`
}
