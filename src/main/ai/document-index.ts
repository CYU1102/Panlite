import type { AiParsedSection } from './document-parser'

const CHUNK_SIZE = 1_400
const CHUNK_OVERLAP = 180
const ENGLISH_STOP_WORDS = new Set('a an the is are was were be been being what which who when where why how do does did please tell me can could would should of for to and or in on at with by about this that these those it its'.split(' '))
const CHINESE_STOP_WORDS = new Set(['的', '了', '是', '吗', '呢', '和', '与', '有', '在', '请问', '什么', '多少', '哪个', '哪些', '如何', '是否', '请', '问'])
const ASCII_TOKEN_PATTERN = /(?:[a-z0-9]+[-_])+[a-z0-9]+|[a-z0-9]*[a-z][a-z0-9]*|[-+]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)[%％]?/g

export interface AiIndexChunk {
  chunkIndex: number
  pageNumber?: number
  section?: string
  startSeconds?: number
  endSeconds?: number
  content: string
}

export interface AiStoredChunk extends AiIndexChunk {
  id: string
  documentId: string
  documentName: string
  sourceSha256?: string
  embedding?: number[]
}

/** A fresh iterator for each pass lets SQLite stream a complete library while
 * keeping only the best few chunks in JavaScript memory. */
export type AiChunkSource = () => Iterable<AiStoredChunk>

function findChunkEnd(text: string, start: number): number {
  const hardEnd = Math.min(text.length, start + CHUNK_SIZE)
  if (hardEnd === text.length) return hardEnd
  const softStart = Math.max(start + Math.floor(CHUNK_SIZE * 0.65), hardEnd - 260)
  const candidate = text.slice(softStart, hardEnd)
  const matches = [...candidate.matchAll(/[。！？!?\n]|\.(?=\s|$)/g)]
    .filter(match => text[softStart + (match.index || 0)] !== '.' || !/\d/.test(text[softStart + (match.index || 0) - 1] || ''))
  if (matches.length) return softStart + (matches[matches.length - 1].index || 0) + 1
  // Keep amounts and identifiers intact when a sentence is longer than a chunk.
  let boundary = hardEnd
  while (boundary > softStart && tokenCharacter(text[boundary - 1]) && tokenCharacter(text[boundary])) boundary--
  if (boundary > softStart) return boundary
  // A pathological token may be longer than the chunk budget; preserve bounded chunks.
  return hardEnd
}

function tokenCharacter(value: string | undefined): boolean { return Boolean(value && /[a-zA-Z0-9_.,+%％\-]/.test(value)) }

export function buildDocumentChunks(sections: AiParsedSection[]): AiIndexChunk[] {
  const chunks: AiIndexChunk[] = []
  for (const section of sections) {
    // Tabs encode spreadsheet columns; indentation and boundary tabs are source data.
    const text = section.content.replace(/\r\n?/g, '\n')
    if (!text.trim()) continue
    let start = 0
    while (start < text.length) {
      const end = findChunkEnd(text, start)
      const content = text.slice(start, end)
      if (content.trim()) chunks.push({
        chunkIndex: chunks.length,
        pageNumber: section.pageNumber,
        section: section.section,
        ...('startSeconds' in section ? { startSeconds: section.startSeconds as number | undefined } : {}),
        ...('endSeconds' in section ? { endSeconds: section.endSeconds as number | undefined } : {}),
        content,
      })
      if (end >= text.length) break
      start = Math.max(start + 1, end - CHUNK_OVERLAP)
    }
  }
  return chunks
}

export function queryTerms(query: string): string[] {
  const normalized = query.toLowerCase().replace(/\s+/g, ' ').trim()
  const terms = new Set<string>()
  for (const word of asciiTokens(normalized)) if (!ENGLISH_STOP_WORDS.has(word)) terms.add(word)
  // Remove only explicit question scaffolding; retain source-language bigrams rather than guessing word segmentation.
  const chineseRuns = normalized.replace(/请问|请告诉我|告诉我|请帮我|帮我|是什么|是多少|有哪些|有没有|怎么样|为什么|是否|哪个|哪些|多少|什么|是谁/g, ' ').match(/[\u3400-\u9fff]+/g) || []
  for (const run of chineseRuns) {
    if (run.length === 1 && !CHINESE_STOP_WORDS.has(run)) terms.add(run)
    for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2))
  }
  return [...terms].slice(0, 40)
}

function normalizeAsciiToken(token: string): string {
  if (!/^[-+]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)[%％]?$/.test(token)) return token
  const suffix = /[%％]$/.test(token) ? '%' : ''
  const clean = token.replace(/[%％]$/, '').replace(/,/g, '').replace(/^\+/, '').replace(/^\./, '0.').replace(/^-\./, '-0.')
  const numeric = clean.includes('.') ? clean.replace(/0+$/, '').replace(/\.$/, '') || '0' : clean
  return numeric + suffix
}

function asciiTokens(text: string): string[] {
  return [...text.matchAll(ASCII_TOKEN_PATTERN)].flatMap(match => {
    const token = normalizeAsciiToken(match[0])
    return /^\d{4}-\d{2}-\d{2}$/.test(token) ? [token, token.slice(0, 4)] : [token]
  })
}

function termCounts(text: string, terms: string[]): number[] {
  const ascii = new Map<string, number>()
  for (const token of asciiTokens(text)) ascii.set(token, (ascii.get(token) || 0) + 1)
  return terms.map(term => /[a-z0-9]/.test(term) ? Math.min(5, ascii.get(term) || 0) : countOccurrences(text, term))
}

export function isDocumentSummaryQuery(query: string): boolean {
  const value = query.trim()
  return /^(?:请你|请帮我|请给我|请|帮我|给我)?\s*(?:总结|概述|概括|梳理)(?:一下)?(?:全文|这些文档|这些文件|这份文档|这份文件|全部文档|全部文件|文档|文件|内容)?(?:的)?(?:核心内容|主要内容|要点)?[。！？?!\s]*$/.test(value)
    || /^(?:please\s+)?(?:summari[sz]e(?:\s+(?:the\s+)?(?:documents?|files?|contents?|text|whole text|entire document))?|(?:give|provide)(?:\s+me)?\s+(?:a\s+)?(?:summary|overview)(?:\s+of\s+(?:the\s+)?(?:documents?|files?|text|contents?))?)[.?!\s]*$/i.test(value)
}

function sampleDocumentChunks(chunks: AiStoredChunk[], limit: number): AiStoredChunk[] {
  if (limit <= 0 || !chunks.length) return []
  if (chunks.length <= limit) return chunks
  if (limit === 1) return [chunks[0]]
  const step = (chunks.length - 1) / (limit - 1)
  return Array.from({ length: limit }, (_, index) => chunks[Math.round(index * step)])
}

function resultLimit(limit: number, length: number): number {
  return Number.isFinite(limit) ? Math.min(length, Math.max(0, Math.floor(limit))) : 0
}

function queryAnchorIndexes(query: string, terms: string[]): number[] {
  const comparison = /(?:大于|小于|超过|低于|高于|至少|至多|不超过|不少于|多于|少于|[<>]|\b(?:over|under|above|below|between|greater|less|more|least|most)\b)/i.test(query)
  return terms.map((term, index) => /\d/.test(term) && (!comparison || /[a-z]/.test(term)) ? index : -1).filter(index => index >= 0)
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let position = 0
  while (count < 5 && (position = haystack.indexOf(needle, position)) >= 0) {
    count++
    position += needle.length
  }
  return count
}

export function rankDocumentChunks(chunks: AiStoredChunk[], query: string, limit = 8): AiStoredChunk[] {
  limit = resultLimit(limit, chunks.length)
  if (!limit) return []
  if (isDocumentSummaryQuery(query)) return sampleDocumentChunks(chunks, limit)
  const terms = queryTerms(query)
  const indexed = chunks.map(chunk => ({ chunk, counts: termCounts(chunk.content.toLowerCase(), terms), titleCounts: termCounts(chunk.documentName.toLowerCase(), terms) }))
  const weights = terms.map((_, index) => Math.log(1 + (chunks.length + 1) / (1 + indexed.filter(item => item.counts[index] > 0).length)))
  const anchors = queryAnchorIndexes(query, terms)
  const ranked = indexed.map(({ chunk, counts, titleCounts }, originalIndex) => {
    // A query specifying an identifier or amount must not be answered using a different identifier or amount.
    if (anchors.some(index => !counts[index] && !titleCounts[index])) return { chunk, score: 0, originalIndex }
    let score = 0
    for (let index = 0; index < terms.length; index++) {
      const frequency = counts[index]
      if (frequency) score += weights[index] * (1 + Math.log(frequency))
    }
    // Titles can break ties but cannot supply evidence absent from the chunk itself.
    if (score) score += titleCounts.reduce((bonus, count, index) => bonus + (count ? weights[index] * 0.2 : 0), 0)
    return { chunk, score, originalIndex }
  }).sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)

  const matching = ranked.filter(item => item.score > 0).slice(0, limit).map(item => item.chunk)
  if (matching.length) return matching
  return []
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return -1
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : -1
}

export function rankDocumentChunksHybrid(chunks: AiStoredChunk[], query: string, queryEmbedding: number[] | null, limit = 8): AiStoredChunk[] {
  limit = resultLimit(limit, chunks.length)
  if (!limit) return []
  if (isDocumentSummaryQuery(query)) return sampleDocumentChunks(chunks, limit)
  const terms = queryTerms(query)
  const anchors = queryAnchorIndexes(query, terms).map(index => terms[index])
  if (anchors.length) {
    chunks = chunks.filter(chunk => {
      const content = termCounts(chunk.content.toLowerCase(), anchors)
      const title = termCounts(chunk.documentName.toLowerCase(), anchors)
      return anchors.every((_, index) => content[index] || title[index])
    })
    if (!chunks.length) return []
  }
  if (!queryEmbedding?.length || !chunks.some(chunk => chunk.embedding?.length === queryEmbedding.length)) {
    return rankDocumentChunks(chunks, query, limit)
  }
  const lexical = rankDocumentChunks(chunks, query, Math.min(chunks.length, Math.max(limit * 8, 64)))
  const lexicalRank = new Map(lexical.map((chunk, index) => [chunk.id, 1 - index / Math.max(1, lexical.length)]))
  return chunks.map((chunk, index) => {
    const semantic = chunk.embedding ? Math.max(0, cosineSimilarity(chunk.embedding, queryEmbedding)) : 0
    const keyword = lexicalRank.get(chunk.id) || 0
    return { chunk, score: semantic * 0.62 + keyword * 0.38, index }
  }).sort((left, right) => right.score - left.score || left.index - right.index)
    .filter(item => item.score > 0).slice(0, limit).map(item => item.chunk)
}

/** Same global lexical weights and hybrid rank fusion as the array retriever,
 * without an arbitrary candidate cutoff or materializing the whole library. */
export function rankDocumentChunkSource(source: AiChunkSource, query: string, queryEmbedding: number[] | null, limit = 8): AiStoredChunk[] {
  if (!Number.isFinite(limit) || limit <= 0) return []
  limit = Math.floor(limit)
  const summary = isDocumentSummaryQuery(query)
  const terms = queryTerms(query)
  const anchors = queryAnchorIndexes(query, terms)
  const frequencies = terms.map(() => 0)
  let count = 0, compatibleEmbedding = false
  const evidence = (chunk: AiStoredChunk) => {
    const counts = termCounts(chunk.content.toLowerCase(), terms)
    const titleCounts = termCounts(chunk.documentName.toLowerCase(), terms)
    return anchors.some(index => !counts[index] && !titleCounts[index]) ? undefined : { counts, titleCounts }
  }
  for (const chunk of source()) {
    if (summary) { count++; continue }
    const item = evidence(chunk)
    if (!item) continue
    count++
    item.counts.forEach((frequency, index) => { if (frequency) frequencies[index]++ })
    if (queryEmbedding?.length && chunk.embedding?.length === queryEmbedding.length) compatibleEmbedding = true
  }
  limit = Math.min(limit, count)
  if (!limit) return []
  if (summary) {
    const positions = new Set(limit === 1 ? [0] : Array.from({ length: limit }, (_, index) => Math.round(index * (count - 1) / (limit - 1))))
    const sampled: AiStoredChunk[] = []
    let index = 0
    for (const chunk of source()) if (positions.has(index++)) sampled.push(chunk)
    return sampled
  }

  type Ranked = { chunk: AiStoredChunk; score: number; index: number }
  const keep = (best: Ranked[], item: Ranked, maximum: number) => {
    if (!(item.score > 0) || (best.length === maximum && item.score <= best[best.length - 1].score)) return
    best.push(item)
    best.sort((left, right) => right.score - left.score || left.index - right.index)
    if (best.length > maximum) best.pop()
  }
  const weights = frequencies.map(frequency => Math.log(1 + (count + 1) / (1 + frequency)))
  const lexical: Ranked[] = []
  const lexicalLimit = compatibleEmbedding ? Math.min(count, Math.max(limit * 8, 64)) : limit
  let index = 0
  for (const chunk of source()) {
    const item = evidence(chunk)
    if (!item) continue
    let score = item.counts.reduce((sum, frequency, term) => sum + (frequency ? weights[term] * (1 + Math.log(frequency)) : 0), 0)
    if (score) score += item.titleCounts.reduce((sum, frequency, term) => sum + (frequency ? weights[term] * 0.2 : 0), 0)
    keep(lexical, { chunk, score, index: index++ }, lexicalLimit)
  }
  if (!compatibleEmbedding) return lexical.map(item => item.chunk)
  const lexicalRank = new Map(lexical.map(({ chunk }, rank) => [chunk.id, 1 - rank / Math.max(1, lexical.length)]))
  const best: Ranked[] = []
  index = 0
  for (const chunk of source()) {
    if (!evidence(chunk)) continue
    const semantic = chunk.embedding ? Math.max(0, cosineSimilarity(chunk.embedding, queryEmbedding!)) : 0
    keep(best, { chunk, score: semantic * 0.62 + (lexicalRank.get(chunk.id) || 0) * 0.38, index: index++ }, limit)
  }
  return best.map(item => item.chunk)
}

/** Return an exact source substring near the query evidence; preserve table tabs and line breaks. */
export function buildCitationQuote(content: string, query: string, maximum = 240): string {
  if (content.length <= maximum) return content
  const terms = queryTerms(query)
  const normalized = content.toLowerCase()
  const hits: Array<{ index: number; term: string }> = []
  for (const match of normalized.matchAll(ASCII_TOKEN_PATTERN)) {
    const token = normalizeAsciiToken(match[0])
    if (terms.includes(token)) hits.push({ index: match.index || 0, term: token })
  }
  for (const term of terms.filter(term => /[\u3400-\u9fff]/.test(term))) {
    let from = 0
    for (let count = 0; count < 20; count++) {
      const index = normalized.indexOf(term, from)
      if (index < 0) break
      hits.push({ index, term })
      from = index + term.length
    }
  }
  let bestStart = 0
  let bestScore = -1
  for (const hit of hits) {
    let start = Math.max(0, Math.min(content.length - maximum, hit.index - 60))
    const previousLine = content.lastIndexOf('\n', hit.index)
    if (previousLine >= start) start = previousLine + 1
    const end = start + maximum
    const covered = new Set(hits.filter(item => item.index >= start && item.index + item.term.length <= end).map(item => item.term))
    const score = [...covered].reduce((sum, term) => sum + (/\d/.test(term) ? 3 : 1), 0)
    if (score > bestScore) { bestStart = start; bestScore = score }
  }
  return content.slice(bestStart, bestStart + maximum)
}

export function stripChunkOverlap(previous: string, current: string, maximum = 300): string {
  const limit = Math.min(maximum, previous.length, current.length)
  for (let length = limit; length >= 12; length--) {
    if (previous.slice(-length) === current.slice(0, length)) return current.slice(length)
  }
  return current
}
