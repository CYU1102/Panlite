// Experiment only: geometry can flag suspicious column separation, not prove semantics.
export function inspectKeyValueLayout(tsv) {
  const lines = new Map()
  const words = []
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    if (!row.trim()) continue
    const columns = row.split('\t')
    if (columns.length < 12) continue
    const level = Number(columns[0])
    const key = columns.slice(1, 5).join('/')
    if (level === 4) {
      const [left, top, width, height] = columns.slice(6, 10).map(Number)
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return { suspected: false, reason: 'Invalid geometry' }
      lines.set(key, { key, page: columns[1], block: columns.slice(1, 3).join('/'), left, top, width, height, words: [] })
    } else if (level === 5 && columns.slice(11).join('\t').trim()) {
      words.push({ id: words.length, lineKey: key, text: columns.slice(11).join('\t') })
    }
  }
  for (const word of words) {
    if (!lines.has(word.lineKey)) return { suspected: false, reason: 'Missing parent line geometry' }
    lines.get(word.lineKey).words.push(word)
  }
  const rows = [...lines.values()].filter(line => line.words.length)
  if (new Set(rows.map(line => line.page)).size !== 1) return { suspected: false, reason: 'Only one page supported' }
  for (const row of rows) row.text = row.words.map(word => word.text).join(' ')
  const blocks = new Map()
  for (const row of rows) {
    if (!blocks.has(row.block)) blocks.set(row.block, [])
    blocks.get(row.block).push(row)
  }
  const candidates = []
  for (const labels of blocks.values()) {
    // A complete block must look like at least three short colon-terminated labels.
    if (labels.length < 3 || labels.some(line => !/[:：]\s*$/u.test(line.text) || [...line.text.replace(/\s/gu, '')].length > 12 || line.width < line.height * 3)) continue
    const pairs = []
    for (const label of labels) {
      const mates = rows.filter(line => line.block !== label.block && line.left >= label.left + label.width && Math.abs((line.top + line.height / 2) - (label.top + label.height / 2)) <= Math.min(line.height, label.height) * 0.2 && line.height / label.height >= 0.5 && line.height / label.height <= 2)
      if (mates.length !== 1) break
      pairs.push([label, mates[0]])
    }
    if (pairs.length === labels.length && new Set(pairs.flat().map(line => line.key)).size === pairs.length * 2) candidates.push(pairs)
  }
  if (candidates.length !== 1) return { suspected: false, reason: candidates.length ? 'Multiple ambiguous regions' : 'No narrowly matching label/value region' }
  const pairs = candidates[0]
  const consumed = new Set(pairs.flat().map(line => line.key))
  const proposedRows = []
  let inserted = false
  for (const row of rows) {
    if (!consumed.has(row.key)) proposedRows.push(row)
    else if (!inserted) { proposedRows.push(...pairs.flat()); inserted = true }
  }
  return {
    suspected: true,
    safeToAutomaticallyReorder: false,
    warning: '疑似标签与内容被分为独立列，阅读顺序及对应关系可能不正确，请对照原图核对；保留原始 OCR 正文。',
    pairCount: pairs.length,
    originalTokenIds: words.map(word => word.id),
    proposedTokenIds: proposedRows.flatMap(row => row.words.map(word => word.id)),
    proposedText: proposedRows.map(row => row.text).join('\n'),
  }
}
