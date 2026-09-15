import type { Text as PdfText } from 'pdf2json'

// pdf2json 4.x emits UTF-8 text directly. URI decoding corrupts literal %20/%41.
// Its fixed 1.5 viewport scale and 24-pixel grid put x/y in 1/16-point units,
// while w remains in PDF points (verified against the installed source and PDFs).
const POINTS_PER_UNIT = 16
const ROW_TOLERANCE = 0.18

interface Block { source: PdfText; value: string; index: number }
interface Row { y: number; blocks: Block[] }

function separator(left: Block, right: Block): string {
  if (left.source.R.some(run => run.RA) || right.source.R.some(run => run.RA)) return '\n'
  const width = left.source.w / POINTS_PER_UNIT
  const gap = right.source.x - left.source.x - width
  const glyphWidth = width / Math.max(1, [...left.value].length)
  if (!Number.isFinite(gap) || !(width > 0)) return ' '
  if (gap > Math.max(1, glyphWidth * 3)) return '\t'
  if (/\s$/.test(left.value) || /^\s/.test(right.value)) return ''
  // Strong overlap can reflect horizontal scaling absent from the JSON width.
  // Keep a boundary instead of silently concatenating independently drawn words.
  if (gap < -Math.max(0.04, glyphWidth * 0.2)) return ' '
  // Touching glyph runs are one word/number, even across drawing/style changes.
  return gap <= Math.max(0.025, glyphWidth * 0.2) ? '' : ' '
}

export function pdfTextWarnings(texts: PdfText[]): string[] {
  const warnings: string[] = []
  const value = texts.map(block => block.R.map(run => run.T || '').join('')).join('')
  if (/\uFFFD|\u0000/.test(value)) warnings.push('文本层含无法映射的字符，原文已保留，请核对原 PDF')
  if (texts.some(block => block.R.some(run => run.RA))) warnings.push('含旋转文本，已按文字块提取，阅读顺序需核对')
  return warnings
}

export function extractPdfPageText(texts: PdfText[]): string {
  const seen = new Set<string>()
  const blocks = texts.map((source, index) => ({ source, index, value: source.R.map(run => run.T || '').join('') }))
    .filter(block => {
      if (!block.value.trim()) return false
      // Only identical text painted at exactly the same location is a duplicate.
      // Text repeated in another row/cell remains source content.
      const key = JSON.stringify([block.source.x, block.source.y, block.source.w, block.source.R.map(run => run.RA || 0), block.value])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).sort((left, right) => left.source.y - right.source.y || left.source.x - right.source.x || left.index - right.index)
  const rows: Row[] = []
  for (const block of blocks) {
    const row = rows[rows.length - 1]
    // Use a fixed row anchor, not the preceding block: successive y drift must
    // not chain several separate baselines into one line.
    if (row && Math.abs(block.source.y - row.y) <= ROW_TOLERANCE) row.blocks.push(block)
    else rows.push({ y: block.source.y, blocks: [block] })
  }
  return rows.map(row => {
    const ordered = row.blocks.sort((left, right) => left.source.x - right.source.x || left.index - right.index)
    return ordered.map((block, index) => `${index ? separator(ordered[index - 1], block) : ''}${block.value}`).join('').trim()
  }).join('\n')
}
