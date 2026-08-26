export interface LatexManuscriptViewMemory {
  path: string
  selection: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
  scrollTop: number
  scrollLeft: number
}

export interface LatexPdfViewMemory {
  pageNumber: number
  scrollTop: number
  zoom: number
}

const manuscriptViews = new Map<string, LatexManuscriptViewMemory>()
const pdfViews = new Map<string, LatexPdfViewMemory>()

export function loadLatexManuscriptView(
  projectId: string
): LatexManuscriptViewMemory | null {
  return manuscriptViews.get(projectId) ?? null
}

export function saveLatexManuscriptView(
  projectId: string,
  view: LatexManuscriptViewMemory
): void {
  manuscriptViews.set(projectId, view)
}

export function loadLatexPdfView(projectId: string): LatexPdfViewMemory | null {
  return pdfViews.get(projectId) ?? null
}

export function saveLatexPdfView(
  projectId: string,
  view: LatexPdfViewMemory
): void {
  pdfViews.set(projectId, view)
}
