import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState
} from 'react'
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  FileType2,
  LoaderCircle,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Zap
} from 'lucide-react'
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type PDFDocumentLoadingTask,
  type RenderTask
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { LatexPdfDocument, LatexPdfSnapshot } from '@shared/types'
import {
  loadLatexAutoCompile,
  saveLatexAutoCompile
} from '../lib/latexAutoCompile'
import {
  loadLatexPdfView,
  saveLatexPdfView,
  type LatexPdfViewMemory
} from '../lib/latexViewMemory'
import { loadPdfPageSize, savePdfPageSize } from '../lib/pdfPageLayout'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

const MIN_ZOOM = 0.5
const MAX_ZOOM = 2.5
const ZOOM_STEP = 0.25
const DEFAULT_PAGE_WIDTH = 612
const DEFAULT_PAGE_HEIGHT = 792
const AUTO_COMPILE_POLL_MS = 2_500

interface LatexPdfPreviewProps {
  projectId: string
  mainFile: string
  local: boolean
}

interface LatexPdfPageProps {
  snapshotId: string
  beforeLayoutChange(): void
  afterLayoutChange(): void
  pdf: PDFDocumentProxy
  pageNumber: number
  scrollRoot: HTMLDivElement | null
  zoom: number
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

function LatexPdfPage({
  snapshotId,
  beforeLayoutChange,
  afterLayoutChange,
  pdf,
  pageNumber,
  scrollRoot,
  zoom
}: LatexPdfPageProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [nearViewport, setNearViewport] = useState(false)
  const [rendering, setRendering] = useState(false)
  const [size, setSize] = useState(() => loadPdfPageSize(snapshotId, pageNumber) ?? {
    width: DEFAULT_PAGE_WIDTH,
    height: DEFAULT_PAGE_HEIGHT
  })
  const sizeRef = useRef(size)
  useLayoutEffect(afterLayoutChange, [afterLayoutChange, size.width, size.height])

  useEffect(() => {
    const shell = shellRef.current
    if (!shell || !scrollRoot) return
    if (typeof IntersectionObserver === 'undefined') {
      setNearViewport(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { root: scrollRoot, rootMargin: '1200px 0px' }
    )
    observer.observe(shell)
    return () => observer.disconnect()
  }, [scrollRoot])

  useEffect(() => {
    let cancelled = false
    let renderTask: RenderTask | null = null
    const canvas = canvasRef.current
    if (!canvas) return

    if (!nearViewport) {
      canvas.width = 1
      canvas.height = 1
      setRendering(false)
      return
    }

    void pdf
      .getPage(pageNumber)
      .then((page) => {
        if (cancelled) return
        const viewport = page.getViewport({ scale: zoom })
        const naturalSize = page.getViewport({ scale: 1 })
        if (sizeRef.current.width !== naturalSize.width || sizeRef.current.height !== naturalSize.height) {
          beforeLayoutChange()
          const nextSize = { width: naturalSize.width, height: naturalSize.height }
          sizeRef.current = nextSize
          savePdfPageSize(snapshotId, pageNumber, nextSize)
          setSize(nextSize)
        } else {
          savePdfPageSize(snapshotId, pageNumber, sizeRef.current)
        }
        if (!nearViewport || !canvasRef.current) return
        const target = canvasRef.current
        const context = target.getContext('2d', { alpha: false })
        if (!context) throw new Error('PanePilot could not prepare a PDF page.')
        const outputScale = Math.max(1, window.devicePixelRatio || 1)
        target.width = Math.max(1, Math.floor(viewport.width * outputScale))
        target.height = Math.max(1, Math.floor(viewport.height * outputScale))
        target.style.width = `${Math.floor(viewport.width)}px`
        target.style.height = `${Math.floor(viewport.height)}px`
        setRendering(true)
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
        // A failed page should not take down navigation for the rest of the PDF.
        console.error(`Could not render PDF page ${pageNumber}`, caught)
      })
      .finally(() => {
        if (!cancelled) setRendering(false)
      })

    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [beforeLayoutChange, nearViewport, pageNumber, pdf, snapshotId, zoom])

  return (
    <div
      ref={shellRef}
      className="latex-pdf-page"
      data-pdf-page={pageNumber}
      style={{ width: size.width * zoom, height: size.height * zoom }}
      aria-label={`Page ${pageNumber}`}
      aria-busy={rendering}
    >
      <span className="latex-pdf-folio" aria-hidden="true">
        {pageNumber}
      </span>
      {rendering && (
        <div className="latex-pdf-rendering">
          <LoaderCircle className="spin" size={17} /> Rendering page {pageNumber}
        </div>
      )}
      <canvas ref={canvasRef} />
    </div>
  )
}

export function LatexPdfPreview({
  projectId,
  mainFile,
  local
}: LatexPdfPreviewProps) {
  const savedViewRef = useRef(loadLatexPdfView(projectId))
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const snapshotIdRef = useRef<string | null>(null)
  const loadVersionRef = useRef(0)
  const printVersionRef = useRef(0)
  const compileInFlightRef = useRef(false)
  const autoCheckInFlightRef = useRef(false)
  const autoRevisionRef = useRef<string | null>(null)
  const restoredScrollRef = useRef(false)
  const pageNumberRef = useRef(savedViewRef.current?.pageNumber ?? 1)
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [metadata, setMetadata] = useState<
    Pick<LatexPdfDocument, 'path' | 'size' | 'modifiedAt'> | null
  >(null)
  const [pageNumber, setPageNumber] = useState(
    savedViewRef.current?.pageNumber ?? 1
  )
  const [zoom, setZoom] = useState(savedViewRef.current?.zoom ?? 1)
  const [loading, setLoading] = useState(true)
  const [compiling, setCompiling] = useState(false)
  const [autoCompile, setAutoCompile] = useState(() =>
    loadLatexAutoCompile(projectId)
  )
  const autoCompileRef = useRef(autoCompile)
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState('')
  const [autoCompileError, setAutoCompileError] = useState('')
  const expectedPath = compiledPdfPath(mainFile)
  const scrollRootRef = useRef(scrollRoot)
  const pageElementsRef = useRef<HTMLElement[]>([])
  const zoomRef = useRef(zoom)
  scrollRootRef.current = scrollRoot
  zoomRef.current = zoom
  const latestViewRef = useRef<LatexPdfViewMemory>(savedViewRef.current ?? {
    pageNumber: 1, scrollTop: 0, pageOffset: -34, zoom
  })
  const pendingAnchorRef = useRef<LatexPdfViewMemory | null>(null)

  const currentView = useCallback((): LatexPdfViewMemory => {
    const root = scrollRootRef.current
    if (!root?.isConnected || !root.clientHeight) return latestViewRef.current
    const cachedPage = pageElementsRef.current[pageNumberRef.current - 1]
    const page = cachedPage?.isConnected ? cachedPage : root.querySelector<HTMLElement>(`[data-pdf-page="${pageNumberRef.current}"]`)
    return {
      pageNumber: pageNumberRef.current, scrollTop: root.scrollTop, zoom: zoomRef.current,
      pageOffset: page ? root.getBoundingClientRect().top - page.getBoundingClientRect().top : undefined
    }
  }, [])

  const beforeLayoutChange = useCallback(() => {
    pendingAnchorRef.current ??= currentView()
  }, [currentView])

  const afterLayoutChange = useCallback(() => {
    const root = scrollRootRef.current
    const anchor = pendingAnchorRef.current
    const document = documentRef.current
    if (!root?.clientHeight || !anchor || !document) return
    const page = Math.max(1, Math.min(document.numPages, anchor.pageNumber))
    const cachedPage = pageElementsRef.current[page - 1]
    const element = cachedPage?.isConnected ? cachedPage : root.querySelector<HTMLElement>(`[data-pdf-page="${page}"]`)
    if (!element) return
    if (anchor.pageOffset == null) root.scrollTop = anchor.scrollTop
    else root.scrollTop += element.getBoundingClientRect().top - root.getBoundingClientRect().top + anchor.pageOffset * zoomRef.current / anchor.zoom
    pageNumberRef.current = page
    setPageNumber(page)
    latestViewRef.current = currentView()
    pendingAnchorRef.current = null
  }, [currentView])

  const releaseSnapshot = (id: string) => {
    void window.projectConsole.latex.releasePdfSnapshot(id).catch(() => {
      // Window destruction also releases every owner-scoped snapshot.
    })
  }

  const installPdf = useCallback(
    async (document: LatexPdfSnapshot, version: number) => {
      const { dataBase64, snapshotId, ...nextMetadata } = document
      let installed = false
      let nextDocument: PDFDocumentProxy | null = null
      let loadingTask: PDFDocumentLoadingTask | null = null
      try {
        if (version !== loadVersionRef.current) return
        loadingTask = getDocument({ data: decodeBase64(dataBase64) })
        nextDocument = await loadingTask.promise
        if (version !== loadVersionRef.current) {
          return
        }
        await window.projectConsole.latex.acceptPdfSnapshot(snapshotId)
        if (version !== loadVersionRef.current) {
          return
        }
        beforeLayoutChange()
        const previousDocument = documentRef.current
        const previousSnapshot = snapshotIdRef.current
        documentRef.current = nextDocument
        snapshotIdRef.current = snapshotId
        installed = true
        setPdf(nextDocument)
        setMetadata(nextMetadata)
        const numPages = nextDocument.numPages
        setPageNumber((current) => {
          const nextPage = Math.max(1, Math.min(numPages, current))
          pageNumberRef.current = nextPage
          return nextPage
        })
        if (previousSnapshot) releaseSnapshot(previousSnapshot)
        if (previousDocument) await previousDocument.destroy()
      } finally {
        if (!installed) {
          releaseSnapshot(snapshotId)
          if (nextDocument) await nextDocument.destroy()
          else if (loadingTask) await loadingTask.destroy()
        }
      }
    },
    [beforeLayoutChange]
  )

  const loadPdf = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setError('')
    try {
      await installPdf(
        await window.projectConsole.latex.getPdfSnapshot(projectId, expectedPath),
        version
      )
    } catch (caught) {
      if (version !== loadVersionRef.current) return
      if (!documentRef.current) {
        setPdf(null)
        setMetadata(null)
      }
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      if (version === loadVersionRef.current) setLoading(false)
    }
  }, [expectedPath, installPdf, projectId])

  const recompilePdf = useCallback(async () => {
    if (compileInFlightRef.current) return
    compileInFlightRef.current = true
    const version = ++loadVersionRef.current
    setCompiling(true)
    setError('')
    try {
      await installPdf(
        await window.projectConsole.latex.compilePdfSnapshot(projectId),
        version
      )
      void window.projectConsole.latex
        .sourceRevision(projectId)
        .then((revision) => {
          if (version === loadVersionRef.current) {
            autoRevisionRef.current = revision
          }
        })
        .catch(() => {
          // The next enabled watcher tick can establish a fresh baseline.
        })
    } catch (caught) {
      if (version === loadVersionRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      compileInFlightRef.current = false
      if (version === loadVersionRef.current) setCompiling(false)
    }
  }, [installPdf, projectId])

  useEffect(() => {
    void loadPdf()
    return () => {
      loadVersionRef.current += 1
      printVersionRef.current += 1
      const currentDocument = documentRef.current
      documentRef.current = null
      const currentSnapshot = snapshotIdRef.current
      snapshotIdRef.current = null
      if (currentSnapshot) releaseSnapshot(currentSnapshot)
      if (currentDocument) void currentDocument.destroy()
    }
  }, [loadPdf])

  useEffect(() => {
    autoCompileRef.current = autoCompile
    if (!autoCompile) {
      autoRevisionRef.current = null
      return
    }

    async function checkForSourceChanges() {
      if (!autoCompileRef.current || autoCheckInFlightRef.current) return
      autoCheckInFlightRef.current = true
      try {
        const revision = await window.projectConsole.latex.sourceRevision(projectId)
        if (!autoCompileRef.current) return
        setAutoCompileError('')
        const previous = autoRevisionRef.current
        autoRevisionRef.current = revision
        if (previous != null && previous !== revision) {
          await recompilePdf()
        }
      } catch (caught) {
        if (autoCompileRef.current) {
          setAutoCompileError(
            caught instanceof Error ? caught.message : String(caught)
          )
        }
      } finally {
        autoCheckInFlightRef.current = false
      }
    }

    void checkForSourceChanges()
    const timer = window.setInterval(
      () => void checkForSourceChanges(),
      AUTO_COMPILE_POLL_MS
    )
    return () => {
      autoCompileRef.current = false
      window.clearInterval(timer)
    }
  }, [autoCompile, projectId, recompilePdf])

  useLayoutEffect(() => {
    if (!pdf || !scrollRoot) return
    pageElementsRef.current = Array.from(scrollRoot.querySelectorAll<HTMLElement>('[data-pdf-page]'))
    if (!restoredScrollRef.current) {
      restoredScrollRef.current = true
      pendingAnchorRef.current = savedViewRef.current ?? latestViewRef.current
    }
    afterLayoutChange()
  }, [afterLayoutChange, pdf, scrollRoot, zoom])

  useEffect(() => {
    if (!scrollRoot || !pdf) return
    let frame = 0
    // The stack is ordered and page heights may differ. Cache its nodes once,
    // then locate the reading anchor with O(log pages) geometry reads per frame.
    const pages = pageElementsRef.current
    const updateCurrentPage = () => {
      if (frame) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        const rootBounds = scrollRoot.getBoundingClientRect()
        const anchor = rootBounds.top + Math.min(140, rootBounds.height / 3)
        let low = 0
        let high = pages.length
        while (low < high) {
          const middle = (low + high) >>> 1
          if (pages[middle].getBoundingClientRect().bottom <= anchor) low = middle + 1
          else high = middle
        }
        let closestPage = pageNumberRef.current
        let closestDistance = Number.POSITIVE_INFINITY
        for (const index of [low - 1, low]) {
          const page = pages[index]
          if (!page) continue
          const bounds = page.getBoundingClientRect()
          const distance = bounds.top <= anchor && bounds.bottom > anchor ? 0
            : Math.min(Math.abs(bounds.top - anchor), Math.abs(bounds.bottom - anchor))
          if (distance < closestDistance) {
            closestDistance = distance
            closestPage = Number(page.dataset.pdfPage)
          }
        }
        pageNumberRef.current = closestPage
        setPageNumber(closestPage)
        latestViewRef.current = currentView()
        saveLatexPdfView(projectId, latestViewRef.current)
      })
    }
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateCurrentPage)
    const stack = scrollRoot.firstElementChild
    if (stack) resizeObserver?.observe(stack)
    scrollRoot.addEventListener('scroll', updateCurrentPage, { passive: true })
    updateCurrentPage()
    return () => {
      resizeObserver?.disconnect()
      scrollRoot.removeEventListener('scroll', updateCurrentPage)
      window.cancelAnimationFrame(frame)
    }
  }, [currentView, pdf, projectId, scrollRoot, zoom])

  useLayoutEffect(() => {
    latestViewRef.current = currentView()
    saveLatexPdfView(projectId, latestViewRef.current)
  }, [currentView, pageNumber, projectId, scrollRoot, zoom])

  useLayoutEffect(() => () => {
    // Layout cleanup runs before DOM detachment resets scrollTop to zero.
    latestViewRef.current = currentView()
    saveLatexPdfView(projectId, latestViewRef.current)
  }, [currentView, projectId])

  function goToPage(nextPage: number) {
    if (!pdf || !scrollRoot || !Number.isFinite(nextPage)) return
    const targetPage = Math.max(1, Math.min(pdf.numPages, nextPage))
    pageNumberRef.current = targetPage
    setPageNumber(targetPage)
    const target = pageElementsRef.current[targetPage - 1]
    if (!target) return
    const rootBounds = scrollRoot.getBoundingClientRect()
    const targetBounds = target.getBoundingClientRect()
    scrollRoot.scrollTo({
      top: scrollRoot.scrollTop + targetBounds.top - rootBounds.top - 20,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth'
    })
  }

  function changeZoom(delta: number) {
    beforeLayoutChange()
    setZoom((current) =>
      Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, current + delta))
    )
  }

  function toggleAutoCompile() {
    const enabled = !autoCompile
    autoCompileRef.current = enabled
    autoRevisionRef.current = null
    setAutoCompile(enabled)
    saveLatexAutoCompile(projectId, enabled)
    setError('')
    setAutoCompileError('')
  }

  async function showInFinder() {
    if (!metadata) return
    setError('')
    try {
      await window.projectConsole.files.showInFolder(projectId, metadata.path)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function printPdf() {
    if (!pdf || !metadata || printing) return
    const version = ++printVersionRef.current
    const snapshotId = snapshotIdRef.current
    setPrinting(true)
    setError('')

    try {
      if (!snapshotId) throw new Error('Reload the PDF preview before printing this document.')
      const snapshot = await window.projectConsole.latex.readPdfSnapshot(snapshotId)
      await window.projectConsole.latex.printPdf({
        path: snapshot.path,
        dataBase64: snapshot.dataBase64
      })
    } catch (caught) {
      if (version === printVersionRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught))
      }
    } finally {
      if (version === printVersionRef.current) setPrinting(false)
    }
  }

  if (loading && !pdf) {
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
        <p>
          {error ||
            autoCompileError ||
            `PanePilot could not open “${expectedPath}”.`}
        </p>
        <small>
          Recompile uses <code>latexmk</code> on the project machine and places
          the PDF beside the configured main file.
        </small>
        <div className="latex-pdf-missing-actions">
          <button
            className={`secondary-button latex-pdf-auto-compile ${
              autoCompile ? 'active' : ''
            }`}
            onClick={toggleAutoCompile}
            aria-pressed={autoCompile}
            title="Compile automatically after LaTeX source files change"
          >
            <Zap size={13} /> Auto compile
          </button>
          <button
            className="primary-button"
            onClick={() => void recompilePdf()}
            disabled={compiling}
          >
            {compiling ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <RefreshCw size={13} />
            )}
            {compiling ? 'Compiling…' : 'Recompile'}
          </button>
        </div>
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
        <div className="latex-pdf-zoom-controls" aria-label="PDF zoom and actions">
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
            className={`secondary-button latex-pdf-auto-compile ${
              autoCompile ? 'active' : ''
            }`}
            onClick={toggleAutoCompile}
            aria-pressed={autoCompile}
            title={
              autoCompile
                ? 'Auto compile is on for this project'
                : 'Compile automatically after LaTeX source files change'
            }
          >
            <Zap size={13} /> Auto compile
          </button>
          <button
            className="secondary-button latex-pdf-compile-button"
            disabled={compiling || printing}
            onClick={() => void recompilePdf()}
            title="Run latexmk and reload this PDF"
          >
            {compiling ? (
              <LoaderCircle className="spin" size={13} />
            ) : (
              <RefreshCw size={13} />
            )}
            {compiling ? 'Compiling…' : 'Recompile'}
          </button>
          {local && (
            <button
              className="icon-button"
              onClick={() => void showInFinder()}
              aria-label="Show compiled PDF in Finder"
              title="Show compiled PDF in Finder"
            >
              <FolderOpen size={14} />
            </button>
          )}
          <button
            className="secondary-button latex-pdf-print-button"
            disabled={printing || compiling}
            onClick={() => void printPdf()}
            title="Open the system print dialog"
          >
            {printing ? (
              <LoaderCircle className="spin" size={14} />
            ) : (
              <Printer size={14} />
            )}
            {printing ? 'Opening print dialog…' : 'Print'}
          </button>
        </div>
      </header>
      {(error || autoCompileError) && (
        <div className="latex-pdf-inline-error">
          {error || autoCompileError}
        </div>
      )}
      <div className="latex-pdf-pasteboard" ref={setScrollRoot}>
        <div className="latex-pdf-pages">
          {Array.from({ length: pdf.numPages }, (_, index) => (
            <LatexPdfPage
              key={`${snapshotIdRef.current}:${index + 1}`}
              snapshotId={snapshotIdRef.current!}
              beforeLayoutChange={beforeLayoutChange}
              afterLayoutChange={afterLayoutChange}
              pdf={pdf}
              pageNumber={index + 1}
              scrollRoot={scrollRoot}
              zoom={zoom}
            />
          ))}
        </div>
      </div>
    </section>
  )
}
