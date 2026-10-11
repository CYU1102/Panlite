/** Parse a deliberately small Markdown subset into text nodes, never executable HTML. */
export interface AiInlineToken { type: 'text' | 'code' | 'strong' | 'emphasis' | 'link'; text: string; href?: string }
export interface AiMarkdownBlock {
  type: 'paragraph' | 'heading' | 'code' | 'quote' | 'list' | 'rule' | 'table'
  text: string
  level?: number
  marker?: string
  language?: string
  headers?: string[]
  rows?: string[][]
}

export function safeAiLink(value: string): string {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : '' } catch { return '' }
}

export function aiInlineTokens(text: string): AiInlineToken[] {
  const tokens: AiInlineToken[] = []
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\s)]+\))/g
  let offset = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index || 0, value = match[0]
    if (index > offset) tokens.push({ type: 'text', text: text.slice(offset, index) })
    if (value.startsWith('`')) tokens.push({ type: 'code', text: value.slice(1, -1) })
    else if (value.startsWith('**') || value.startsWith('__')) tokens.push({ type: 'strong', text: value.slice(2, -2) })
    else if (value.startsWith('*') || value.startsWith('_')) tokens.push({ type: 'emphasis', text: value.slice(1, -1) })
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value), href = link ? safeAiLink(link[2]) : ''
      tokens.push(href ? { type: 'link', text: link![1], href } : { type: 'text', text: value })
    }
    offset = index + value.length
  }
  if (offset < text.length) tokens.push({ type: 'text', text: text.slice(offset) })
  return tokens
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|'))
}

export function aiMarkdownBlocks(content: string): AiMarkdownBlock[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n'), blocks: AiMarkdownBlock[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      const code: string[] = [], close = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`)
      while (++index < lines.length && !close.test(lines[index])) code.push(lines[index])
      blocks.push({ type: 'code', text: code.join('\n'), language: fence[2].trim() }); continue
    }
    if (line.includes('|') && index + 1 < lines.length) {
      const headers = tableCells(line), separator = tableCells(lines[index + 1])
      if (headers.length > 1 && separator.length === headers.length && separator.every(cell => /^:?-{3,}:?$/.test(cell))) {
        index++
        const rows: string[][] = []
        while (index + 1 < lines.length && lines[index + 1].trim() && lines[index + 1].includes('|')) {
          const cells = tableCells(lines[++index]); rows.push(headers.map((_, cell) => cells[cell] || ''))
        }
        blocks.push({ type: 'table', text: '', headers, rows }); continue
      }
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line), quote = /^\s*>\s?(.*)$/.exec(line), list = /^\s*([-+*]|\d+[.)])\s+(.+)$/.exec(line)
    if (heading) blocks.push({ type: 'heading', text: heading[2], level: heading[1].length })
    else if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) blocks.push({ type: 'rule', text: '' })
    else if (quote) blocks.push({ type: 'quote', text: quote[1] })
    else if (list) blocks.push({ type: 'list', text: list[2], marker: list[1] })
    else blocks.push({ type: 'paragraph', text: line })
  }
  return blocks
}
