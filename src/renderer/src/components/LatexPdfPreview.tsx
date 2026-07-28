import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FileType2,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw
} from 'lucide-react'
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { LatexPdfDocument } from '@shared/types'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.5
const ZOOM_STEP = 0.25

interface LatexPdfPreviewProps {
  projectId: string
  mainFile: string
}

function decodeBase64(value: string): Uint8Array {
  const decoded = window.atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function compiledPdfPath(mainFile: string): string {
  return mainFile.replace(/\.tex$/i, '.pdf')
}

export function LatexPdfPreview({
  projectId,
  mainFile
}: LatexPdfPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const loadVersionRef = useRef(0)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [metadata, setMetadata] = useState<
    Pick<LatexPdfDocument, 'path' | 'size' | 'modifiedAt'> | null
  >(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [zoom, setZoom] = useState(1)
  const [loading, setLoading] = useState(true)
  const [rendering, setRendering] = useState(false)
  const [error, setError] = useState('')
  const expectedPath = compiledPdfPath(mainFile)

  const loadPdf = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setError('')
    try {
      const { dataBase64, ...nextMetadata } =
        await window.projectConsole.latex.getPdf(projectId)
      const loadingTask = getDocument({ data: decodeBase64(dataBase64) })
      const nextDocument = await loadingTask.promise
      if (version !== loadVersionRef.current) {
        await nextDocument.destroy()
        return
      }
      const previousDocument = documentRef.current
      documentRef.current = nextDocument
      setPdf(nextDocument)
      setMetadata(nextMetadata)
      setPageNumber(1)
      if (previousDocument) await previousDocument.destroy()
    } catch (caught) {
      if (version !== loadVersionRef.current) return
      const previousDocument = documentRef.current
      documentRef.current = null
      setPdf(null)
      setMetadata(null)
      setError(caught instanceof Error ? caught.message : String(caught))
      if (previousDocument) await previousDocument.destroy()
    } finally {
      if (version === loadVersionRef.current) setLoading(false)
    }
  }, [mainFile, projectId])

  useEffect(() => {
    void loadPdf()
    return () => {
      loadVersionRef.current += 1
      const currentDocument = documentRef.current
      documentRef.current = null
      if (currentDocument) void currentDocument.destroy()
    }
  }, [loadPdf])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    let renderTask: RenderTask | null = null
    let cancelled = false
    setRendering(true)
    setError('')

    void pdf
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled || !canvasRef.current) return
        const viewport = page.getViewport({ scale: zoom })
        const outputScale = Math.max(1, window.devicePixelRatio || 1)
        const canvas = canvasRef.current
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('PanePilot could not prepare the PDF canvas.')
        canvas.width = Math.floor(viewport.width * outputScale)
        canvas.height = Math.floor(viewport.height * outputScale)
        canvas.style.width = `${Math.floor(viewport.width)}px`
        canvas.style.height = `${Math.floor(viewport.height)}px`
        renderTask = page.render({
          canvasContext: context,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
          background: '#ffffff'
        })
        return renderTask.promise
      })
      .catch((caught) => {
        if (cancelled || caught?.name === 'RenderingCancelledException') return
        setError(caught instanceof Error ? caught.message : String(caught))
      })
      .finally(() => {
        if (!cancelled) setRendering(false)
      })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [pageNumber, pdf, zoom])

  function goToPage(nextPage: number) {
    if (!pdf) return
    setPageNumber(Math.max(1, Math.min(pdf.numPages, nextPage)))
  }

  function changeZoom(delta: number) {
    setZoom((current) =>
      Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current + delta))
    )
  }

  if (loading) {
    return (
      <div className="latex-pdf-state" role="status">
        <LoaderCircle className="spin" size={28} />
        <strong>Opening the compiled paper</strong>
        <span>{expectedPath}</span>
      </div>
    )
  }

  if (!pdf || !metadata) {
    return (
      <div className="latex-pdf-state latex-pdf-missing">
        <div className="latex-pdf-file-mark">
          <FileType2 size={24} />
          <span>PDF</span>
        </div>
        <strong>No compiled PDF to preview</strong>
        <p>{error || `PanePilot could not open “${expectedPath}”.`}</p>
        <small>
          Build <code>{expectedPath}</code> with your LaTeX command or a project
          Action, then refresh this view.
        </small>
        <button className="primary-button" onClick={() => void loadPdf()}>
          <RefreshCw size={13} /> Refresh PDF
        </button>
      </div>
    )
  }

  return (
    <section className="latex-pdf-preview" aria-label="Compiled PDF preview">
      <header className="latex-pdf-toolbar">
        <div className="latex-pdf-document-meta">
          <FileType2 size={16} />
          <span>
            <strong>{metadata.path}</strong>
            <small>
              {formatBytes(metadata.size)} · built{' '}
              {new Date(metadata.modifiedAt).toLocaleString()}
            </small>
          </span>
        </div>
        <div className="latex-pdf-page-controls" aria-label="PDF page navigation">
          <button
            className="icon-button"
            disabled={pageNumber <= 1}
            onClick={() => goToPage(pageNumber - 1)}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft size={15} />
          </button>
          <label>
            <span className="sr-only">Page</span>
            <input
              type="number"
              min={1}
              max={pdf.numPages}
              value={pageNumber}
              onChange={(event) => goToPage(Number(event.target.value))}
            />
            <small>of {pdf.numPages}</small>
          </label>
          <button
            className="icon-button"
            disabled={pageNumber >= pdf.numPages}
            onClick={() => goToPage(pageNumber + 1)}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="latex-pdf-zoom-controls" aria-label="PDF zoom">
          <button
            className="icon-button"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => changeZoom(-ZOOM_STEP)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={14} />
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button
            className="icon-button"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => changeZoom(ZOOM_STEP)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-button latex-pdf-refresh"
            onClick={() => void loadPdf()}
            aria-label="Reload compiled PDF"
            title="Reload compiled PDF"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>
      {error && <div className="latex-pdf-inline-error">{error}</div>}
      <div className="latex-pdf-pasteboard">
        <div className="latex-pdf-page" aria-busy={rendering}>
          {rendering && (
            <div className="latex-pdf-rendering">
              <LoaderCircle className="spin" size={17} /> Rendering page
            </div>
          )}
          <canvas ref={canvasRef} />
        </div>
      </div>
    </section>
  )
}
