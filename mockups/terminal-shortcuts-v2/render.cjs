const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const concepts = [
  '01-soft-tiers.png',
  '02-quiet-rules.png',
  '03-colour-brackets.png',
  '04-tinted-bays.png',
  '05-lean-focus-path.png'
]

async function render() {
  const window = new BrowserWindow({
    width: 1200,
    height: 820,
    frame: false,
    show: false,
    backgroundColor: '#0b0e15',
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })

  for (const [index, filename] of concepts.entries()) {
    await window.loadFile(path.join(__dirname, 'mockup.html'), {
      query: { variant: String(index + 1) }
    })
    await window.webContents.executeJavaScript('document.fonts.ready')
    window.webContents.invalidate()
    await new Promise((resolve) => setTimeout(resolve, 120))
    const image = await window.webContents.capturePage()
    fs.writeFileSync(path.join(__dirname, filename), image.toPNG())
    console.log(filename, image.getSize())
  }

  window.destroy()
}

app.whenReady().then(render).then(() => app.quit()).catch((error) => {
  console.error(error)
  app.exit(1)
})
