import { describe, expect, it } from 'vitest'
import { buildDocumentChunks, cosineSimilarity, queryTerms, rankDocumentChunks, rankDocumentChunksHybrid, stripChunkOverlap, type AiStoredChunk } from './document-index'

describe('AI local document index', () => {
  it('keeps page metadata while splitting long content', () => {
    const chunks = buildDocumentChunks([{ pageNumber: 3, section: '第 3 页', content: '段落内容。'.repeat(500) }])
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.pageNumber === 3 && chunk.section === '第 3 页')).toBe(true)
  })

  it('builds Chinese bigrams and ASCII query terms', () => {
    expect(queryTerms('会员 expiry date')).toEqual(expect.arrayContaining(['会员', 'expiry', 'date']))
  })

  it('ranks a matching chunk before unrelated content', () => {
    const chunks: AiStoredChunk[] = [
      { id: 'a', documentId: 'd1', documentName: '说明.txt', chunkIndex: 0, content: '这是普通介绍。' },
      { id: 'b', documentId: 'd1', documentName: '说明.txt', chunkIndex: 1, pageNumber: 2, content: '会员有效期截止到十二月。' },
    ]
    expect(rankDocumentChunks(chunks, '会员有效期')[0].id).toBe('b')
  })

  it('combines semantic similarity with keyword ranking', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    const chunks: AiStoredChunk[] = [
      { id: 'keyword', documentId: 'd1', documentName: '项目说明', chunkIndex: 0, content: '苹果发布计划', embedding: [0, 1] },
      { id: 'semantic', documentId: 'd2', documentName: '语义文档', chunkIndex: 0, content: '没有直接关键词', embedding: [1, 0] },
    ]
    expect(rankDocumentChunksHybrid(chunks, '苹果', [1, 0], 1)[0].id).toBe('semantic')
  })

  it('removes repeated chunk overlap during full export', () => {
    const overlap = '这是两个索引片段之间重复的上下文内容。'
    expect(stripChunkOverlap(`前文${overlap}`, `${overlap}后文`)).toBe('后文')
  })
})
