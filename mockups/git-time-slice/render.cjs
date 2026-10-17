const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')

const concepts = [
  '01-aperture.png',
  '02-branch-atlas.png',
  '03-quiet-ledger.png',
  '04-merge-lens.png'
]

async function render() {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    frame: false,
    show: false,
    backgroundColor: '#090b0e',
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })

  for (const [index, filename] of concepts.entries()) {
    await window.loadFile(path.join(__dirname, 'mockup.html'), {
      query: { variant: String(index + 1) }
    })
    await window.webContents.executeJavaScript('new Promise((resolve) => { const check = () => window.__mockupReady ? resolve() : setTimeout(check, 20); check() })')
    await window.webContents.executeJavaScript('document.fonts.ready')
    window.webContents.invalidate()
    await new Promise((resolve) => setTimeout(resolve, 600))
    const image = await window.webContents.capturePage()
    fs.writeFileSync(path.join(__dirname, filename), image.toPNG())
    console.log(filename, image.getSize())

    if (index === 0) {
      const selection = await window.webContents.executeJavaScript(`(() => {
        document.querySelector('.branch-chip[data-branch="release"]').click()
        document.querySelector('.commit-node[data-hash="2a76bdf"]').click()
        return {
          selectedBranch: document.querySelector('.branch-chip[aria-pressed="true"]').dataset.branch,
          selectedHash: document.querySelector('.commit-node.selected').dataset.hash,
          subject: document.getElementById('story-subject').textContent,
          mergeSource: document.getElementById('merge-source').textContent,
          overviewHasPosition: Number(document.getElementById('overview').getAttribute('aria-valuenow')) >= 0
        }
      })()`)
      assert.deepEqual(selection, {
        selectedBranch: 'release',
        selectedHash: '2a76bdf',
        subject: 'Merge release validation',
        mergeSource: 'release/0.13',
        overviewHasPosition: true
      })
      await window.webContents.executeJavaScript('document.getElementById("close").click()')
      await new Promise((resolve) => setTimeout(resolve, 350))
      assert.equal(await window.webContents.executeJavaScript('document.querySelector(".history-modal").style.display'), 'none')
      await window.webContents.executeJavaScript('document.getElementById("reopen").click()')
      assert.equal(await window.webContents.executeJavaScript('document.querySelector(".history-modal").style.display'), 'block')
      console.log('Interactive controls: branch filter, commit selection, close, reopen passed')
    }
  }

  window.destroy()
}

app.whenReady().then(render).then(() => app.quit()).catch((error) => {
  console.error(error)
  app.exit(1)
})
