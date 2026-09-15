import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAiDocument } from './document-parser'

vi.mock('./ai-provider', () => ({ getAiProviderConfig: vi.fn(), extractTextFromVisualFile: vi.fn(), transcribeMediaFile: vi.fn() }))
vi.mock('./local-ai-tools', () => ({ convertLegacyOfficeLocally: vi.fn(), extractEmbeddedSubtitle: vi.fn(), ocrImageLocally: vi.fn(), ocrPdfLocally: vi.fn(), transcribeMediaLocally: vi.fn(), withRenderedPdfPage: vi.fn() }))
vi.mock('./processing-policy', () => ({ getAiProcessingPolicy: () => ({ allowModelFallback: false, useSemanticIndex: false }) }))

const directories: string[] = []
beforeEach(() => vi.clearAllMocks())
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

async function fixture(extension: string, entries: Record<string, string>): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'panlite-office-accuracy-'))
  directories.push(directory)
  const filePath = join(directory, `fixture.${extension}`)
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(filePath)
    const zip = require('archiver')('zip')
    output.on('close', resolve)
    output.on('error', reject)
    zip.on('error', reject)
    zip.pipe(output)
    for (const [name, content] of Object.entries(entries)) zip.append(content, { name })
    void zip.finalize()
  })
  return filePath
}

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`
const cell = (text: string) => `<w:tc>${paragraph(text)}</w:tc>`

describe('Office extraction accuracy', () => {
  it('preserves Word table row, empty-cell and multi-paragraph cell boundaries', async () => {
    const filePath = await fixture('docx', { 'word/document.xml': `<w:document><w:body>${paragraph('Before table')}<w:tbl><w:tr>${cell('Name')}${cell('Description')}</w:tr><w:tr>${cell('')}<w:tc>${paragraph('Line one')}${paragraph('Line two')}</w:tc></w:tr></w:tbl>${paragraph('After table')}</w:body></w:document>` })
    expect((await parseAiDocument(filePath, 'docx')).sections?.[0].content).toBe('Before table\nName\tDescription\n\t"Line one\\nLine two"\nAfter table')
  })

  it('extracts the current Word revision without deleted or moved-from text and rows', async () => {
    const filePath = await fixture('docx', { 'word/document.xml': `<w:document><w:body><w:moveFrom>${paragraph('Old location')}</w:moveFrom><w:moveTo>${paragraph('New location')}</w:moveTo><w:del>${paragraph('Deleted text')}</w:del><w:ins>${paragraph('Inserted text')}</w:ins><w:tbl><w:tr><w:trPr><w:del w:id="1"/></w:trPr>${cell('Deleted row')}</w:tr><w:tr>${cell('Current row')}</w:tr></w:tbl></w:body></w:document>` })
    expect((await parseAiDocument(filePath, 'docx')).sections?.[0].content).toBe('New location\nInserted text\nCurrent row')
  })

  it('preserves merged-cell spans and omitted leading columns without shifting later values', async () => {
    const filePath = await fixture('docx', { 'word/document.xml': '<w:document><w:body><w:tbl><w:tr><w:trPr><w:gridBefore w:val="1"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged B-C</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Column D</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' })
    expect((await parseAiDocument(filePath, 'docx')).sections?.[0].content).toBe('\tMerged B-C\t\tColumn D')
  })

  it('preserves nested table content within its parent cell and accepts quoted angle brackets', async () => {
    const filePath = await fixture('docx', { 'word/document.xml': `<w:document w:custom="a > b"><w:body><w:tbl><w:tr><w:tc>${paragraph('Outer')}<w:tbl><w:tr>${cell('Nested A')}${cell('Nested B')}</w:tr></w:tbl></w:tc>${cell('Last cell')}</w:tr></w:tbl></w:body></w:document>` })
    expect((await parseAiDocument(filePath, 'docx')).sections?.[0].content).toBe('"Outer\\nNested A\\tNested B"\tLast cell')
  })

  it('keeps final inline revision text, paragraph tabs and CDATA literal entity text', async () => {
    const filePath = await fixture('docx', { 'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Current </w:t></w:r><w:moveFrom><w:r><w:t>old </w:t></w:r></w:moveFrom><w:moveTo><w:r><w:t>new</w:t><w:tab/><w:t><![CDATA[A &amp; B]]></w:t></w:r></w:moveTo></w:p></w:body></w:document>' })
    expect((await parseAiDocument(filePath, 'docx')).sections?.[0].content).toBe('Current new\tA &amp; B')
  })

  it('does not confuse paragraph tab-stop formatting with tab characters in the content', async () => {
    const filePath = await fixture('docx', { 'word/document.xml': '<w:document><w:body><w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>First</w:t><w:tab/><w:t>Second</w:t></w:r></w:p></w:body></w:document>' })
    expect((await parseAiDocument(filePath, 'docx')).sections?.[0].content).toBe('First\tSecond')
  })

  it('keeps embedded Excel newline, tabs and literal escapes within a single cell', async () => {
    const filePath = await fixture('xlsx', { 'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Line one&#10;Line two&#9;within cell</t></is></c><c r="B1" t="inlineStr"><is><t>literal\\t</t></is></c><c r="C1"><v>5</v></c></row></sheetData></worksheet>' })
    const result = await parseAiDocument(filePath, 'xlsx')
    expect(result.sections?.[0].content).toBe('"Line one\\nLine two\\twithin cell"\t"literal\\\\t"\t5')
    expect(result.sections?.[0].content.split('\n')).toHaveLength(1)
    expect(result.sections?.[0].content.split('\t')).toHaveLength(3)
    expect(result.sections?.[0].content.split('\t').map(value => value.startsWith('"') ? JSON.parse(value) : value)).toEqual(['Line one\nLine two\twithin cell', 'literal\\t', '5'])
  })

  it.each([['0', '40729'], ['1', '39267']])('interprets workbook date1904=%s using its explicit date system', async (date1904, serial) => {
    const filePath = await fixture('xlsx', {
      'xl/workbook.xml': `<workbook><workbookPr date1904="${date1904}"/><sheets><sheet name="Dates"/></sheets></workbook>`,
      'xl/styles.xml': '<styleSheet><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row><c r="A1" s="1"><v>${serial}</v></c><c r="B1"><v>${serial}</v></c></row></sheetData></worksheet>`,
    })
    expect((await parseAiDocument(filePath, 'xlsx')).sections?.[0].content).toBe(`2011-07-05\t${serial}`)
  })

  it('restores built-in percentage units while retaining cached formula results and unknown formats', async () => {
    const filePath = await fixture('xlsx', {
      'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="0.00 &quot;kg&quot;"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="10"/><xf numFmtId="164"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" s="1"><v>0.25</v></c><c r="B1" s="2"><f>1/8</f><v>0.125</v></c><c r="C1" s="3"><v>5</v></c><c r="D1" t="str" s="1"><v>0.25</v></c></row></sheetData></worksheet>',
    })
    const result = await parseAiDocument(filePath, 'xlsx')
    expect(result.sections?.[0].content).toBe('25%\t12.50%\t5\t0.25')
    expect(result.message).toContain('未重新计算')
  })

  it('rounds percentage display from exact decimal text instead of a binary floating-point approximation', async () => {
    const filePath = await fixture('xlsx', {
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="9"/><xf numFmtId="10"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1"><v>0.285</v></c><c r="B1"><v>-2.85e-1</v></c><c r="C1" s="1"><v>.00005</v></c><c r="D1" s="1"><v>0.000049</v></c></row></sheetData></worksheet>',
    })
    expect((await parseAiDocument(filePath, 'xlsx')).sections?.[0].content).toBe('29%\t-29%\t0.01%\t0.00%')
  })

  it('handles the Excel 1900 leap-year compatibility value without silently changing dates', async () => {
    const filePath = await fixture('xlsx', {
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c><v>1</v></c><c><v>59</v></c><c><v>60</v></c><c><v>61</v></c><c><v>-1</v></c><c><v>0</v></c><c><v>9999999999</v></c></row></sheetData></worksheet>',
    })
    expect((await parseAiDocument(filePath, 'xlsx')).sections?.[0].content).toBe('1900-01-01\t1900-02-28\t1900-02-29 [Excel 兼容日期，实际不存在]\t1900-03-01\t-1\t0\t9999999999')
  })

  it('supports serial zero in the explicitly selected 1904 date system', async () => {
    const filePath = await fixture('xlsx', {
      'xl/workbook.xml': '<workbook><workbookPr date1904="true"/><sheets><sheet name="Dates"/></sheets></workbook>',
      'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c><v>0</v></c></row></sheetData></worksheet>',
    })
    expect((await parseAiDocument(filePath, 'xlsx')).sections?.[0].content).toBe('1904-01-01')
  })

  it('honors explicitly disabled number formats and preserves custom overrides as raw values', async () => {
    const filePath = await fixture('xlsx', {
      'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="14" formatCode="0.00 &quot;kg&quot;"/></numFmts><cellStyleXfs><xf numFmtId="0"/></cellStyleXfs><cellXfs><xf numFmtId="9" applyNumberFormat="0" xfId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1" s="0"><v>0.25</v></c><c r="B1" s="1"><v>40729</v></c></row></sheetData></worksheet>',
    })
    expect((await parseAiDocument(filePath, 'xlsx')).sections?.[0].content).toBe('0.25\t40729')
  })
})
