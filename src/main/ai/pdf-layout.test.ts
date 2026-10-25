import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { layoutPdf, literalPdfText } from './test-fixtures/pdf-layout'
import { parseAiDocument } from './document-parser'
import { ocrPdfLocally } from './local-ai-tools'
import { extractPdfPageText, pdfTextWarnings } from './pdf-text-layout'
import type { Text as PdfText } from 'pdf2json'

vi.mock('./local-ai-tools', () => ({ ocrPdfLocally: vi.fn(async () => null), withRenderedPdfPage: vi.fn(async () => null) }))
vi.mock('./processing-policy', () => ({ getAiProcessingPolicy: () => ({ allowModelFallback: false, useSemanticIndex: false }) }))
vi.mock('./ai-provider', () => ({ getAiProviderConfig: vi.fn(), extractTextFromVisualFile: vi.fn(), transcribeMediaFile: vi.fn() }))

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
async function extract(stream: string): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'panlite-pdf-layout-'))
  directories.push(directory)
  const filePath = join(directory, 'layout.pdf')
  writeFileSync(filePath, layoutPdf([stream]))
  const result = await parseAiDocument(filePath, 'pdf')
  expect(result.status).toBe('ready')
  return result.sections![0].content
}

describe('PDF text accuracy against literal PDF operators', () => {
  it.each(['https://example.test/a%2Fb?q=hello%20world', '%41', 'discount 25%'])('preserves literal source text %s', async text => {
    expect(await extract(literalPdfText(text))).toBe(text)
  })
  it('keeps a decimal amount contiguous across separate drawing operators', async () => {
    expect(await extract(literalPdfText('12') + literalPdfText('.50', 86.4))).toBe('12.50')
  })
  it('keeps a word contiguous across a font style boundary', async () => {
    expect(await extract(literalPdfText('Pan') + literalPdfText('Lite', 93.6))).toBe('PanLite')
  })
  it('preserves a real word gap between separately positioned text blocks', async () => {
    expect(await extract(literalPdfText('Hello') + literalPdfText('world', 115.2))).toBe('Hello world')
  })
  it('preserves words in text with horizontal scaling', async () => {
    const left = literalPdfText('Hello').replace('/F1 12 Tf', '/F1 12 Tf 50 Tz')
    const right = literalPdfText('world', 93.6).replace('/F1 12 Tf', '/F1 12 Tf 50 Tz')
    expect(await extract(left + right)).toBe('Hello world')
  })
  it('deduplicates coincident overpaint without removing repetitions on other lines', async () => {
    expect(await extract(literalPdfText('Approved') + literalPdfText('Approved') + literalPdfText('Approved', 72, 700))).toBe('Approved\nApproved')
  })
  it('preserves visibly separated table cells', async () => {
    expect(await extract(literalPdfText('Item') + literalPdfText('Amount', 260) + literalPdfText('A-12', 72, 700) + literalPdfText('12.50', 260, 700))).toBe('Item\tAmount\nA-12\t12.50')
  })
  it('retains successful OCR pages when another page fails and shows the page diagnostic', async () => {
    vi.mocked(ocrPdfLocally).mockResolvedValueOnce([
      { pageNumber: 1, content: '第一张发票：12.50' },
      { pageNumber: 2, content: '', warnings: ['该页图像损坏，未识别'] },
      { pageNumber: 3, content: '第三张发票：18.00' },
    ])
    const directory = mkdtempSync(join(tmpdir(), 'panlite-pdf-ocr-pages-'))
    directories.push(directory)
    const filePath = join(directory, 'scanned.pdf')
    writeFileSync(filePath, layoutPdf(['', '', '']))
    const result = await parseAiDocument(filePath, 'pdf')
    expect(result).toMatchObject({ status: 'ready', partial: true })
    expect(result.sections?.map(page => [page.pageNumber, page.content])).toEqual([[1, '第一张发票：12.50'], [3, '第三张发票：18.00']])
    expect(result.message).toContain('第 2 页：该页图像损坏')
  })
  it('keeps uncertain recognized text visible and discloses low confidence even when all pages contain text', async () => {
    vi.mocked(ocrPdfLocally).mockResolvedValueOnce([{ pageNumber: 1, content: '总额：I2.50', confidence: 44, warnings: ['低置信度文字需核对：I2.50'] }])
    const directory = mkdtempSync(join(tmpdir(), 'panlite-pdf-ocr-quality-'))
    directories.push(directory)
    const filePath = join(directory, 'scanned.pdf')
    writeFileSync(filePath, layoutPdf(['']))
    const result = await parseAiDocument(filePath, 'pdf')
    expect(result).toMatchObject({ status: 'ready', partial: true })
    expect(result.sections?.[0].content).toBe('总额：I2.50')
    expect(result.message).toContain('第 1 页：低置信度文字需核对')
  })
})

function block(value: string, x: number, y: number, width = 16): PdfText {
  return { x, y, w: width, sw: 0.3, A: 'left', R: [{ T: value, S: -1, TS: [0, 12, 0, 0] }] }
}

describe('PDF block preservation', () => {
  it('joins adjoining CJK characters without introducing artificial spaces', () => {
    expect(extractPdfPageText([block('金', 1, 1), block('额', 2, 1), block('：', 3, 1), block('12.50', 4, 1)])).toBe('金额：12.50')
  })
  it('keeps a fixed baseline when small y offsets accumulate across drawing operators', () => {
    expect(extractPdfPageText([block('A', 1, 1), block('B', 2, 1.12), block('C', 1, 1.24)])).toBe('AB\nC')
  })
  it('reports unmappable text without replacing or inventing missing characters', () => {
    const source = [block('合同号：\uFFFD12', 1, 1)]
    expect(extractPdfPageText(source)).toBe('合同号：\uFFFD12')
    expect(pdfTextWarnings(source)).toEqual([expect.stringContaining('无法映射')])
  })
})
