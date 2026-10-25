export interface PdfTextPosition { str: string; transform: number[]; width: number; height: number }
export interface PdfHighlightBox { left: number; top: number; width: number; height: number }
export interface PdfViewport { transform: number[]; scale: number }

function normalized(value: string): string { return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase() }

/** Match an exact normalized quote across PDF text runs; draw only real matching text geometry. */
function matchedRanges(source: string, needle: string, context?: string): Array<{ start: number; end: number }> {
  if (!needle) return []
  const full = normalized(context || '')
  const contextIndex = full ? source.indexOf(full) : -1
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = contextIndex >= 0 ? contextIndex : 0
  const maximum = contextIndex >= 0 ? contextIndex + full.length : source.length
  while (cursor < maximum) {
    const start = source.indexOf(needle, cursor)
    if (start < 0 || start + needle.length > maximum) break
    ranges.push({ start, end: start + needle.length }); cursor = start + needle.length
  }
  return ranges
}
export function pdfCitationMatchCount(items: PdfTextPosition[], quote: string, context?: string): number {
  return matchedRanges(items.map(item => normalized(item.str)).join(''), normalized(quote), context).length
}
export function pdfCitationHighlights(items: PdfTextPosition[], quote: string, viewport: PdfViewport, context?: string): PdfHighlightBox[] {
  const needle = normalized(quote)
  if (!needle) return []
  let source = ''
  const ranges = items.map(item => { const start = source.length; source += normalized(item.str); return { item, start, end: source.length } })
  const matches = matchedRanges(source, needle, context)
  if (!matches.length) return []
  const [a, b, c, d, e, f] = viewport.transform
  return ranges.filter(range => matches.some(match => range.end > match.start && range.start < match.end)).map(({ item }) => {
    const [x0, y0] = [item.transform[4], item.transform[5]]
    const angle = Math.atan2(item.transform[1], item.transform[0])
    const width = Math.abs(item.width)
    const height = Math.abs(item.height) || Math.hypot(item.transform[2], item.transform[3])
    const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => {
      const px = x0 + x * Math.cos(angle) - y * Math.sin(angle)
      const py = y0 + x * Math.sin(angle) + y * Math.cos(angle)
      return [a * px + c * py + e, b * px + d * py + f]
    })
    const xs = corners.map(point => point[0]), ys = corners.map(point => point[1])
    return { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
  }).filter(box => box.width > 0 && box.height > 0)
}
