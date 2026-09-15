import { describe, expect, it } from 'vitest'
import { buildCitationQuote, buildDocumentChunks, cosineSimilarity, queryTerms, rankDocumentChunks, rankDocumentChunksHybrid, stripChunkOverlap, type AiStoredChunk } from './document-index'

// Fixed, answer-bearing bilingual examples. Distractors deliberately precede evidence.
const retrievalCorpus: AiStoredChunk[] = [
  { id: 'wrong-id', documentId: 'finance', documentName: '发票记录.txt', chunkIndex: 0, pageNumber: 1, content: '订单 A-123 金额 120 元。A-123 的金额仍为 120 元。A-123 已支付。' },
  { id: 'id-answer', documentId: 'finance', documentName: '发票记录.txt', chunkIndex: 1, pageNumber: 2, content: '订单 A-12 的金额是 12.50 元，收款人为林青。' },
  { id: 'wrong-amount', documentId: 'expense', documentName: '报销.txt', chunkIndex: 0, pageNumber: 3, content: '金额 125.00 元对应项目 Orange。金额 125.00 已核销。' },
  { id: 'amount-answer', documentId: 'expense', documentName: '报销.txt', chunkIndex: 1, pageNumber: 4, content: '报销金额 1,250.00 元对应项目 Cedar。经办人是周宁。' },
  { id: 'english-substring', documentId: 'manual', documentName: '设备说明.txt', chunkIndex: 0, pageNumber: 5, content: 'The grid is solid. Grid layout and solid construction are standard. Identity checks are recorded.' },
  { id: 'english-answer', documentId: 'manual', documentName: '设备说明.txt', chunkIndex: 1, pageNumber: 6, content: 'The ID for the replacement device is ZX-77.' },
  { id: 'question-filler', documentId: 'faq', documentName: '常见问题.txt', chunkIndex: 0, pageNumber: 7, content: '请问是什么意思？请问是什么？请问是什么？请问是什么？请问是什么？' },
  { id: 'deadline-answer', documentId: 'terms', documentName: '售后条款.txt', chunkIndex: 0, pageNumber: 8, content: '退款期限为签收后 14 天；退款仅退回原支付账户。' },
  { id: 'title-only', documentId: 'draft', documentName: 'Refund deadline policy.txt', chunkIndex: 0, pageNumber: 9, content: 'Office furniture inventory: four desks and six chairs.' },
  { id: 'refund-answer', documentId: 'policy', documentName: 'Customer terms.txt', chunkIndex: 0, pageNumber: 10, content: 'The refund deadline is 30 days after delivery. Contact the support desk for assistance.' },
]
const retrievalCases = [
  { query: '订单 A-12 的金额是多少？', expected: 'id-answer', answer: '12.50', page: 2 },
  { query: '报销金额1250元对应哪个项目？', expected: 'amount-answer', answer: 'Cedar', page: 4 },
  { query: 'What is the ID?', expected: 'english-answer', answer: 'ZX-77', page: 6 },
  { query: '请问退款期限是什么？', expected: 'deadline-answer', answer: '14 天', page: 8 },
  { query: 'What is the refund deadline?', expected: 'refund-answer', answer: '30 days', page: 10 },
  { query: 'Cedar经办人是谁？', expected: 'amount-answer', answer: '周宁', page: 4 },
]

describe('fixed bilingual answer retrieval benchmark', () => {
  it.each(retrievalCases)('retrieves the known answer and source for "$query"', ({ query, expected, answer, page }) => {
    const ranked = rankDocumentChunks(retrievalCorpus, query, 3)
    expect(ranked[0]?.id).toBe(expected)
    expect(ranked[0]?.content).toContain(answer)
    expect(ranked[0]?.pageNumber).toBe(page)
  })
  it.each(['订单 A-999 金额是多少？', 'What is the helicopter serial number?', '请问火星基地地址是什么？'])('returns no invented evidence for the unanswerable question "%s"', query => {
    expect(rankDocumentChunks(retrievalCorpus, query)).toEqual([])
  })
  it('does not treat a title-only keyword match as document evidence', () => {
    expect(rankDocumentChunks(retrievalCorpus.filter(chunk => chunk.id === 'title-only'), 'refund deadline')).toEqual([])
  })
  it('samples only explicit document summaries and keeps source metadata at limits one and three', () => {
    expect(rankDocumentChunks(retrievalCorpus, '总结这些文档的核心内容', 1)).toEqual([retrievalCorpus[0]])
    expect(rankDocumentChunks(retrievalCorpus, 'Please summarize the documents.', 3)).toEqual([retrievalCorpus[0], retrievalCorpus[5], retrievalCorpus[9]])
    expect(rankDocumentChunks(retrievalCorpus, '事故摘要在哪里？', 1)).toEqual([])
  })
  it.each([0, -1, NaN, Infinity])('returns a bounded empty result for an invalid limit %s', limit => {
    expect(rankDocumentChunks(retrievalCorpus, '总结全文', limit)).toEqual([])
    expect(rankDocumentChunks(retrievalCorpus, '订单', limit)).toEqual([])
    expect(rankDocumentChunksHybrid(retrievalCorpus.map(chunk => ({ ...chunk, embedding: [1, 0] })), '订单', [1, 0], limit)).toEqual([])
  })
  it('matches whole numeric values and identifier tokens rather than their prefixes', () => {
    const rows = ['金额120元', '金额12.5元', '金额12元', '金额-12元', '编号 A-120', '编号 A-12'].map((content, index) => ({ ...retrievalCorpus[0], id: String(index), content }))
    expect(rankDocumentChunks(rows, '金额12元').map(chunk => chunk.id)).toEqual(['2'])
    expect(rankDocumentChunks(rows, '金额-12元').map(chunk => chunk.id)).toEqual(['3'])
    expect(rankDocumentChunks(rows, '编号A-12').map(chunk => chunk.id)).toEqual(['5'])
  })
  it('keeps percentages distinct from ordinary amounts, including full-width percent signs', () => {
    const rows = ['折扣金额25元', '折扣比例25％', '折扣比例250%'].map((content, index) => ({ ...retrievalCorpus[0], id: String(index), content }))
    expect(rankDocumentChunks(rows, '25%的折扣').map(chunk => chunk.id)).toEqual(['1'])
    expect(rankDocumentChunks(rows, '25.00％的折扣').map(chunk => chunk.id)).toEqual(['1'])
    expect(rankDocumentChunks(rows, '折扣金额25元').map(chunk => chunk.id)).toEqual(['0'])
  })
  it('retains broad relevant retrieval for comparison questions instead of treating thresholds as exact amounts', () => {
    expect(rankDocumentChunks(retrievalCorpus, '报销金额超过1000元的项目有哪些？').some(chunk => chunk.id === 'amount-answer')).toBe(true)
    const dated = [{ ...retrievalCorpus[0], content: '合同于2025-04-01到期。' }]
    expect(rankDocumentChunks(dated, '2025年的合同')).toHaveLength(1)
  })
  it('places citation excerpts around exact source evidence while preserving spreadsheet columns and newlines', () => {
    const prefix = '一般说明，不涉及具体订单。'.repeat(50)
    const content = `${prefix}\n\tA-12\t\t12.50\t\n\t收款人\t林青\t\n${'其他内容。'.repeat(60)}`
    const quote = buildCitationQuote(content, 'A-12的金额是多少？')
    expect(quote).toContain('\tA-12\t\t12.50\t\n')
    expect(content.includes(quote)).toBe(true)
    expect(quote.length).toBeLessThanOrEqual(240)
  })
})

describe('AI local document index', () => {
  it('keeps page metadata while splitting long content', () => {
    const chunks = buildDocumentChunks([{ pageNumber: 3, section: '第 3 页', content: '段落内容。'.repeat(500) }])
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.pageNumber === 3 && chunk.section === '第 3 页')).toBe(true)
  })

  it('preserves empty spreadsheet columns, boundary tabs and text indentation', () => {
    const content = '\t姓名\t\t年龄\t\r\n\t小明\t\t20\t\r\n    Indented paragraph\t'
    expect(buildDocumentChunks([{ section: '工作表：名单', content }])).toEqual([
      { chunkIndex: 0, section: '工作表：名单', content: content.replace(/\r\n/g, '\n') },
    ])
    expect(buildDocumentChunks([{ content: '\t \n\t' }])).toEqual([])
  })
  it('keeps full identifier and amount evidence across long-content chunk boundaries without losing source characters', () => {
    const content = `${' '.repeat(1375)}订单 AZ-12345678901234567890 金额 12345678.90 元。\n${'背景句。'.repeat(350)}`
    const chunks = buildDocumentChunks([{ pageNumber: 12, content }])
    expect(chunks.some(chunk => chunk.content.includes('AZ-12345678901234567890'))).toBe(true)
    expect(chunks.some(chunk => chunk.content.includes('12345678.90'))).toBe(true)
    expect(chunks.every(chunk => !/[a-zA-Z0-9][.,]?$/.test(chunk.content))).toBe(true)
    // The documented 180-character overlap gives exact reconstruction even for repeated source text.
    const reconstructed = chunks[0].content + chunks.slice(1).map(chunk => chunk.content.slice(180)).join('')
    expect(reconstructed).toBe(content)
    expect(chunks.every(chunk => chunk.pageNumber === 12)).toBe(true)
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
  it('does not let semantic similarity override an exact identifier or amount requirement', () => {
    const chunks = [
      { ...retrievalCorpus[0], embedding: [1, 0] },
      { ...retrievalCorpus[1], embedding: [0, 1] },
    ]
    expect(rankDocumentChunksHybrid(chunks, '订单 A-12 金额是多少？', [1, 0], 2).map(chunk => chunk.id)).toEqual(['id-answer'])
    expect(rankDocumentChunksHybrid(chunks, '订单 A-999 金额是多少？', [1, 0])).toEqual([])
    expect(rankDocumentChunksHybrid(chunks, '金额超过100元的订单', [1, 0]).some(chunk => chunk.id === 'wrong-id')).toBe(true)
  })

  it('removes repeated chunk overlap during full export', () => {
    const overlap = '这是两个索引片段之间重复的上下文内容。'
    expect(stripChunkOverlap(`前文${overlap}`, `${overlap}后文`)).toBe('后文')
  })

  it('retains column separators immediately after an exported overlap', () => {
    const overlap = '这个重复的文字片段长度超过最小重叠匹配要求。'
    expect(stripChunkOverlap(`前文${overlap}`, `${overlap}\t\t第三列`)).toBe('\t\t第三列')
  })
})
