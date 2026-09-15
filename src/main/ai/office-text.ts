/** Keep table delimiters distinct from characters stored inside a cell. */
export function serializeTableCell(value: string): string {
  return /[\t\r\n\\"]/.test(value) ? JSON.stringify(value) : value
}

type WordNode = { name: string; attributes: string; children: Array<WordNode | string> }
const REMOVED_WORD_CONTENT = new Set(['w:del', 'w:moveFrom', 'w:delText'])

/** A bounded structural reader; it does not resolve DTDs or external entities. */
function readWordTree(xml: string, decode: (value: string) => string): WordNode {
  const root: WordNode = { name: '', attributes: '', children: [] }
  const stack = [root]
  let nodes = 0
  for (const match of xml.matchAll(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')+>|[^<]+/g)) {
    const token = match[0]
    const current = stack[stack.length - 1]
    if (token.startsWith('<![CDATA[')) {
      if (current.name === 'w:t') current.children.push(token.slice(9, -3))
    } else if (/^<!|^<\?/.test(token)) continue
    else if (token.startsWith('</')) {
      const name = token.match(/^<\/([\w:.-]+)/)?.[1]
      if (stack.length < 2 || current.name !== name) throw new Error('DOCX XML 标签结构无效')
      stack.pop()
    } else if (token.startsWith('<')) {
      const tag = token.match(/^<([\w:.-]+)([\s\S]*?)\/?\s*>$/)
      if (!tag) throw new Error('DOCX XML 标签无效')
      if (++nodes > 400_000 || stack.length > 256) throw new Error('DOCX XML 结构超过安全解析限制')
      const node: WordNode = { name: tag[1], attributes: tag[2], children: [] }
      current.children.push(node)
      if (!/\/\s*>$/.test(token)) stack.push(node)
    } else if (current.name === 'w:t') current.children.push(decode(token))
  }
  if (stack.length !== 1) throw new Error('DOCX XML 标签未闭合')
  return root
}

function childNodes(node: WordNode): WordNode[] {
  return node.children.filter((child): child is WordNode => typeof child !== 'string')
}

function findContentNodes(node: WordNode, name: string, stopAt: string[] = []): WordNode[] {
  return childNodes(node).flatMap(child => {
    if (REMOVED_WORD_CONTENT.has(child.name)) return []
    if (child.name === name) return [child]
    return stopAt.includes(child.name) ? [] : findContentNodes(child, name, stopAt)
  })
}

function gridWidth(node: WordNode | undefined, tag: string, fallback: number): number {
  const marker = node && childNodes(node).find(child => child.name === tag)
  const value = Number(marker?.attributes.match(/\bw:val\s*=\s*["'](\d+)["']/)?.[1] ?? fallback)
  if (!Number.isInteger(value) || value < 0 || value > 16_384) throw new Error('DOCX 表格列数超出范围')
  return value
}

function inlineWordText(node: WordNode): string {
  if (REMOVED_WORD_CONTENT.has(node.name)) return ''
  // Paragraph tab-stop definitions are formatting, not literal tab characters.
  if (node.name === 'w:pPr' || node.name === 'w:rPr') return ''
  if (node.name === 'w:tab') return '\t'
  if (node.name === 'w:br' || node.name === 'w:cr') return '\n'
  return node.children.map(child => typeof child === 'string' ? child : inlineWordText(child)).join('')
}

function wordBlocks(node: WordNode): string[] {
  if (REMOVED_WORD_CONTENT.has(node.name)) return []
  if (node.name === 'w:p') return [inlineWordText(node)]
  if (node.name === 'w:tbl') {
    const rows: string[] = []
    for (const row of findContentNodes(node, 'w:tr', ['w:tbl'])) {
      const properties = childNodes(row).find(child => child.name === 'w:trPr')
      if (properties && childNodes(properties).some(child => child.name === 'w:del')) continue
      const cells = Array<string>(gridWidth(properties, 'w:gridBefore', 0)).fill('')
      for (const cell of findContentNodes(row, 'w:tc', ['w:tbl', 'w:tr'])) {
        const cellProperties = childNodes(cell).find(child => child.name === 'w:tcPr')
        if (cellProperties && childNodes(cellProperties).some(child => child.name === 'w:cellDel')) continue
        cells.push(serializeTableCell(childNodes(cell).flatMap(wordBlocks).join('\n')))
        const span = gridWidth(cellProperties, 'w:gridSpan', 1)
        for (let index = 1; index < span; index++) cells.push('')
        if (cells.length > 16_384) throw new Error('DOCX 表格列数超出范围')
      }
      rows.push(cells.join('\t'))
    }
    return rows.length ? [rows.join('\n')] : []
  }
  return childNodes(node).flatMap(wordBlocks)
}

export function extractDocxText(xml: string, decode: (value: string) => string): string {
  return wordBlocks(readWordTree(xml, decode)).filter(block => block !== '').join('\n')
}

function formatPercent(raw: string, decimals: number): string {
  if (raw.length > 512) return raw
  const match = raw.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i)
  if (!match || !(match[2] || match[3])) return raw
  const exponent = Number(match[4] || 0)
  const shift = exponent + 2 + decimals - (match[3]?.length || 0)
  if (Math.abs(shift) > 400) return raw
  let units = BigInt(`${match[2] || '0'}${match[3] || ''}`)
  if (shift >= 0) units *= 10n ** BigInt(shift)
  else {
    const divisor = 10n ** BigInt(-shift)
    units = (units + divisor / 2n) / divisor
  }
  const digits = units.toString().padStart(decimals + 1, '0')
  const formatted = decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits
  return `${match[1] === '-' && units !== 0n ? '-' : ''}${formatted}%`
}

/** Only explicitly supported built-in formats are normalized; other values remain raw. */
export function formatXlsxNumber(raw: string, numberFormatId: number, date1904: boolean): string {
  // ISO/IEC 29500 built-in IDs: 9 = 0%, 10 = 0.00%, 14–17 = date displays.
  if (numberFormatId === 9 || numberFormatId === 10) return formatPercent(raw, numberFormatId === 10 ? 2 : 0)
  if (![14, 15, 16, 17].includes(numberFormatId)) return raw
  const serial = Number(raw)
  if (!raw.trim() || !Number.isFinite(serial) || serial < (date1904 ? 0 : 1)) return raw
  const day = Math.floor(serial)
  if (!date1904 && day === 60) return '1900-02-29 [Excel 兼容日期，实际不存在]'
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)
  const date = new Date(epoch + (date1904 ? day : day > 60 ? day - 1 : day) * 86_400_000)
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() <= 9999 ? date.toISOString().slice(0, 10) : raw
}
