import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { BrowserWindow, type WebContents } from 'electron'
import type { PrintLatexPdfInput } from '../shared/types'

const MAX_PDF_BYTES = 32 * 1024 * 1024
const MAX_PDF_BASE64_LENGTH = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4
const PDF_READY_FALLBACK_MS = 5_000

let printInProgress = false

interface PdfReadyEventTarget {
  once(event: '-pdf-ready-to-print', listener: () => void): void
  removeListener(event: '-pdf-ready-to-print', listener: () => void): void
}

function printablePdf(input: PrintLatexPdfInput): { data: Buffer; name: string } {
  if (
    !input ||
    typeof input.path !== 'string' ||
    typeof input.dataBase64 !== 'string'
  ) {
    throw new Error('Choose a valid PDF to print.')
  }
  if (!input.dataBase64 || input.dataBase64.length > MAX_PDF_BASE64_LENGTH) {
    throw new Error('PanePilot prints PDFs up to 32 MB.')
  }
  const data = Buffer.from(input.dataBase64, 'base64')
  if (data.length > MAX_PDF_BYTES) {
    throw new Error('PanePilot prints PDFs up to 32 MB.')
  }
  if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('The selected document is not a valid PDF file.')
  }
  const candidateName = basename(input.path.trim())
  return {
    data,
    name: candidateName && /\.pdf$/i.test(candidateName) ? candidateName : 'document.pdf'
  }
}

function pdfViewerReady(contents: WebContents): {
  promise: Promise<void>
  cancel(): void
} {
  const pdfEvents = contents as unknown as PdfReadyEventTarget
  let finish: (() => void) | null = null
  const promise = new Promise<void>((resolveReady) => {
    let timeout: ReturnType<typeof setTimeout> | null = null
    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout)
      pdfEvents.removeListener('-pdf-ready-to-print', ready)
      contents.removeListener('render-process-gone', ready)
    }
    const ready = (): void => {
      cleanup()
      resolveReady()
    }
    finish = ready
    pdfEvents.once('-pdf-ready-to-print', ready)
    contents.once('render-process-gone', ready)
    timeout = setTimeout(ready, PDF_READY_FALLBACK_MS)
  })
  return {
    promise,
    cancel: () => finish?.()
  }
}

function openSystemPrintDialog(window: BrowserWindow): Promise<void> {
  return new Promise((resolvePrint, rejectPrint) => {
    window.webContents.print(
      {
        silent: false
      },
      (success, failureReason) => {
        if (success || /cancel/i.test(failureReason ?? '')) {
          resolvePrint()
          return
        }
        rejectPrint(
          new Error(failureReason || 'The system print dialog could not be opened.')
        )
      }
    )
  })
}

export async function printLatexPdf(
  input: PrintLatexPdfInput,
  parent: BrowserWindow | null
): Promise<void> {
  if (printInProgress) {
    throw new Error('Another PDF print dialog is already open.')
  }
  printInProgress = true
  let temporaryDirectory: string | null = null
  let printWindow: BrowserWindow | null = null
  let readiness: ReturnType<typeof pdfViewerReady> | null = null

  try {
    const pdf = printablePdf(input)
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'panepilot-pdf-print-'))
    const temporaryPdf = join(temporaryDirectory, pdf.name)
    await writeFile(temporaryPdf, pdf.data, { mode: 0o600 })

    printWindow = new BrowserWindow({
      show: false,
      parent: parent && !parent.isDestroyed() ? parent : undefined,
      title: `Print ${pdf.name}`,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        plugins: true,
        sandbox: true
      }
    })
    readiness = pdfViewerReady(printWindow.webContents)
    await printWindow.loadFile(temporaryPdf)
    await readiness.promise
    if (printWindow.isDestroyed() || printWindow.webContents.isDestroyed()) {
      throw new Error('The PDF print window closed before printing could begin.')
    }

    // Omitting pageRanges is deliberate: Electron passes the PDF plugin's entire
    // document to one native system print dialog and preserves its page ordering.
    await openSystemPrintDialog(printWindow)
  } finally {
    readiness?.cancel()
    if (printWindow && !printWindow.isDestroyed()) printWindow.destroy()
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
    printInProgress = false
  }
}
