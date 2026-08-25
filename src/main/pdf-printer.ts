import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { PrintLatexPdfInput } from '../shared/types'

const MAX_PDF_BYTES = 32 * 1024 * 1024
const MAX_PDF_BASE64_LENGTH = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4
const execFileAsync = promisify(execFile)
const MACOS_PDF_PRINT_SCRIPT = `
ObjC.import('AppKit')
ObjC.import('PDFKit')

function run(argv) {
  const pdfUrl = $.NSURL.fileURLWithPath(argv[0])
  const document = $.PDFDocument.alloc.initWithURL(pdfUrl)
  if (!document) throw new Error('The PDF could not be opened by macOS PDFKit.')

  const operation = document.printOperationForPrintInfoScalingModeAutoRotate(
    $.NSPrintInfo.sharedPrintInfo.copy,
    $.kPDFPrintPageScaleToFit,
    true
  )
  if (!operation) throw new Error('macOS could not create a PDF print operation.')

  operation.showsPrintPanel = true
  operation.showsProgressPanel = true
  const application = $.NSApplication.sharedApplication
  application.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  application.activateIgnoringOtherApps(true)
  return operation.runOperation ? 'printed' : 'cancelled'
}
`

let printInProgress = false

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

export async function printLatexPdf(input: PrintLatexPdfInput): Promise<void> {
  if (printInProgress) {
    throw new Error('Another PDF print dialog is already open.')
  }
  if (process.platform !== 'darwin') {
    throw new Error('Native PDF printing is currently available on macOS.')
  }
  printInProgress = true
  let temporaryDirectory: string | null = null

  try {
    const pdf = printablePdf(input)
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'panepilot-pdf-print-'))
    const temporaryPdf = join(temporaryDirectory, pdf.name)
    await writeFile(temporaryPdf, pdf.data, { mode: 0o600 })
    await execFileAsync(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', MACOS_PDF_PRINT_SCRIPT, '--', temporaryPdf],
      { encoding: 'utf8', maxBuffer: 64 * 1024 }
    )
  } finally {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
    printInProgress = false
  }
}
