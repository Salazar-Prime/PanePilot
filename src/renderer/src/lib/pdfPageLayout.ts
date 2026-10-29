export interface PdfPageSize { width: number; height: number }

// Only scalar geometry is retained. Eviction is safe because reading positions
// also contain a page-relative anchor, independent of preceding page estimates.
const MAX_PAGE_SIZES = 4_096
const sizes = new Map<string, PdfPageSize>()

export function loadPdfPageSize(snapshotId: string, page: number): PdfPageSize | undefined {
  const key = `${snapshotId}:${page}`
  const size = sizes.get(key)
  if (size) { sizes.delete(key); sizes.set(key, size) }
  return size
}

export function savePdfPageSize(snapshotId: string, page: number, size: PdfPageSize): void {
  const key = `${snapshotId}:${page}`
  sizes.delete(key)
  sizes.set(key, size)
  while (sizes.size > MAX_PAGE_SIZES) sizes.delete(sizes.keys().next().value!)
}
