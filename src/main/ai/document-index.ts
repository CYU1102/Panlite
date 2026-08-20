import type { AiParsedSection } from './document-parser'

const CHUNK_SIZE = 1_400
const CHUNK_OVERLAP = 180

export interface AiIndexChunk {
  chunkIndex: number
  pageNumber?: number
  section?: string
  content: string
}

export interface AiStoredChunk extends AiIndexChunk {
  id: string
  documentId: string
  documentName: string
  embedding?: number[]
}

function findChunkEnd(text: string, start: number): number {
  const hardEnd = Math.min(text.length, start + CHUNK_SIZE)
  if (hardEnd === text.length) return hardEnd
  const softStart = Math.max(start + Math.floor(CHUNK_SIZE * 0.65), hardEnd - 260)
  const candidate = text.slice(softStart, hardEnd)
  const matches = [...candidate.matchAll(/[。！？.!?\n]/g)]
  return matches.length ? softStart + (matches[matches.length - 1].index || 0) + 1 : hardEnd
}

export function buildDocumentChunks(sections: AiParsedSection[]): AiIndexChunk[] {
  const chunks: AiIndexChunk[] = []
  for (const section of sections) {
    const text = section.content.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim()
    if (!text) continue
    let start = 0
    while (start < text.length) {
      const end = findChunkEnd(text, start)
      const content = text.slice(start, end).trim()
      if (content) chunks.push({
        chunkIndex: chunks.length,
        pageNumber: section.pageNumber,
        section: section.section,
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
  for (const word of normalized.match(/[a-z0-9_\-]{2,}/g) || []) terms.add(word)
  const chineseRuns = normalized.match(/[\u3400-\u9fff]+/g) || []
  for (const run of chineseRuns) {
    if (run.length === 1) terms.add(run)
    for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2))
  }
  return [...terms].slice(0, 40)
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
  const terms = queryTerms(query)
  const normalizedQuery = query.toLowerCase().trim()
  const ranked = chunks.map((chunk, originalIndex) => {
    const content = chunk.content.toLowerCase()
    const title = chunk.documentName.toLowerCase()
    let score = normalizedQuery.length >= 3 && content.includes(normalizedQuery) ? 16 : 0
    for (const term of terms) {
      score += countOccurrences(content, term) * (term.length > 2 ? 2.2 : 1.2)
      if (title.includes(term)) score += 3
    }
    return { chunk, score, originalIndex }
  }).sort((left, right) => right.score - left.score || left.originalIndex - right.originalIndex)

  const matching = ranked.filter(item => item.score > 0).slice(0, limit).map(item => item.chunk)
  if (matching.length) return matching
  if (chunks.length <= limit) return chunks

  // “总结全文”一类问题没有关键词命中时，均匀抽取文档各处，避免只看到开头。
  const sampled: AiStoredChunk[] = []
  const step = (chunks.length - 1) / (limit - 1)
  for (let index = 0; index < limit; index++) sampled.push(chunks[Math.round(index * step)])
  return [...new Map(sampled.map(chunk => [chunk.id, chunk])).values()]
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
    .slice(0, limit).map(item => item.chunk)
}

export function stripChunkOverlap(previous: string, current: string, maximum = 300): string {
  const limit = Math.min(maximum, previous.length, current.length)
  for (let length = limit; length >= 12; length--) {
    if (previous.slice(-length) === current.slice(0, length)) return current.slice(length).trimStart()
  }
  return current
}
