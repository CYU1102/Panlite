interface OcrLine {
  key: string
  page: string
  block: string
  left: number
  top: number
  width: number
  height: number
  text: string
}

/**
 * Best-effort diagnostics only. Cross-block horizontal alignment does not establish
 * semantic label/value correspondence; never use this to reorder or correct OCR.
 * Bounded input/line counts keep this optional diagnostic cheap for dense pages.
 */
export function detectTesseractReadingOrderWarnings(tsv: string): string[] {
  if (tsv.length > 8 * 1024 * 1024) return []
  const records = tsv.replace(/^\uFEFF/, '').split(/\r?\n/)
  const header = (records.shift() || '').split('\t')
  const fields = ['level', 'page_num', 'block_num', 'par_num', 'line_num', 'left', 'top', 'width', 'height', 'text']
  const indices = Object.fromEntries(fields.map(field => [field, header.indexOf(field)]))
  if (Object.values(indices).some(index => index < 0)) return []
  const lines = new Map<string, OcrLine>()
  const words: Array<{ key: string; text: string }> = []
  for (const record of records) {
    const cells = record.split('\t')
    const key = ['page_num', 'block_num', 'par_num', 'line_num'].map(field => cells[indices[field]]).join('/')
    if (cells[indices.level] === '4') {
      if (lines.size >= 1_000 || lines.has(key)) return []
      const [left, top, width, height] = ['left', 'top', 'width', 'height'].map(field => Number(cells[indices[field]]))
      if (![left, top, width, height].every(Number.isFinite) || left < 0 || top < 0 || width <= 0 || height <= 0) return []
      lines.set(key, { key, page: cells[indices.page_num], block: `${cells[indices.page_num]}/${cells[indices.block_num]}`, left, top, width, height, text: '' })
    } else if (cells[indices.level] === '5') {
      const text = cells.slice(indices.text).join('\t').trim()
      if (!text) continue
      if (words.length >= 50_000) return []
      words.push({ key, text })
    }
  }
  for (const word of words) {
    const line = lines.get(word.key)
    if (!line) return []
    line.text += `${line.text ? ' ' : ''}${word.text}`
  }
  const rows = [...lines.values()].filter(line => line.text)
  if (new Set(rows.map(line => line.page)).size !== 1) return []
  const blocks = new Map<string, OcrLine[]>()
  for (const line of rows) {
    if (!blocks.has(line.block)) blocks.set(line.block, [])
    blocks.get(line.block)!.push(line)
  }
  for (const labels of blocks.values()) {
    if (labels.length < 3 || labels.some(line => !/[:：]\s*$/u.test(line.text) || [...line.text.replace(/\s/gu, '')].length > 12 || line.width < line.height * 3)) continue
    const matched = new Set<string>()
    for (const label of labels) {
      const candidates = rows.filter(line => line.block !== label.block && line.left >= label.left + label.width && Math.abs((line.top + line.height / 2) - (label.top + label.height / 2)) <= Math.min(line.height, label.height) * 0.2 && line.height / label.height >= 0.5 && line.height / label.height <= 2)
      if (candidates.length !== 1 || matched.has(candidates[0].key)) break
      matched.add(candidates[0].key)
    }
    if (matched.size === labels.length) return ['疑似标签与内容被识别为独立列，阅读顺序及对应关系可能不正确；仅检测到跨文本块的水平对齐，不能据此推断语义，已保留原始 OCR 正文，请对照原图核对']
  }
  return []
}
