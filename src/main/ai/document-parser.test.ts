import { afterEach, describe, expect, it } from 'vitest'
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeXmlText, extractXmlTagText, parseAiDocument } from './document-parser'

const archiver = require('archiver')

const tempDirs: string[] = []

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function officeFixture(extension: string, entries: Record<string, string>): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-parser-'))
  tempDirs.push(directory)
  const filePath = join(directory, `fixture.${extension}`)
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(filePath)
    const archive = archiver('zip')
    output.on('close', resolve)
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name })
    void archive.finalize()
  })
  return filePath
}

function pdfFixture(text: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-pdf-'))
  tempDirs.push(directory)
  const filePath = join(directory, 'fixture.pdf')
  const stream = `BT /F1 18 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  writeFileSync(filePath, pdf)
  return filePath
}

describe('AI document parser helpers', () => {
  it('decodes named and numeric XML entities', () => {
    expect(decodeXmlText('A &amp; B &lt; C &#x4E2D;&#25991;')).toBe('A & B < C 中文')
  })

  it('extracts text runs used by DOCX and PPTX', () => {
    expect(extractXmlTagText('<w:t>Hello</w:t><w:t xml:space="preserve"> world</w:t>', 'w:t'))
      .toEqual(['Hello', ' world'])
    expect(extractXmlTagText('<a:t>标题</a:t><a:t>正文</a:t>', 'a:t'))
      .toEqual(['标题', '正文'])
  })

  it('extracts paragraphs from DOCX', async () => {
    const filePath = await officeFixture('docx', {
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p></w:body></w:document>',
    })
    const result = await parseAiDocument(filePath, 'docx')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('Hello world')
  })

  it('extracts worksheets and shared strings from XLSX', async () => {
    const filePath = await officeFixture('xlsx', {
      'xl/sharedStrings.xml': '<sst><si><t>姓名</t></si><si><t>小明</t></si></sst>',
      'xl/workbook.xml': '<workbook><sheets><sheet name="名单" sheetId="1"/></sheets></workbook>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>',
    })
    const result = await parseAiDocument(filePath, 'xlsx')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('工作表：名单')
    expect(result.preview).toContain('姓名\t小明')
  })

  it('extracts slide text and notes from PPTX', async () => {
    const filePath = await officeFixture('pptx', {
      'ppt/slides/slide1.xml': '<p:sld><a:t>标题</a:t><a:t>正文</a:t></p:sld>',
      'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:t>演讲备注</a:t></p:notes>',
    })
    const result = await parseAiDocument(filePath, 'pptx')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('标题')
    expect(result.preview).toContain('备注：\n演讲备注')
  })

  it('extracts text per page from a PDF text layer', async () => {
    const result = await parseAiDocument(pdfFixture('PanLite PDF knowledge'), 'pdf')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('PanLite PDF knowledge')
    expect(result.sections?.[0]).toMatchObject({ pageNumber: 1, section: '第 1 页' })
  })

  it('preserves subtitle time ranges for SRT files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-subtitle-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'movie.srt')
    writeFileSync(filePath, '1\n00:00:01,000 --> 00:00:03,000\n第一句字幕\n\n2\n00:00:04,000 --> 00:00:06,000\nSecond line')
    const result = await parseAiDocument(filePath, 'srt')
    expect(result.status).toBe('ready')
    expect(result.sections?.[0]).toMatchObject({ section: '00:00:01,000 → 00:00:03,000', content: '第一句字幕' })
  })

  it('prefers a matching sidecar subtitle before media transcription', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-media-'))
    tempDirs.push(directory)
    const mediaPath = join(directory, 'lesson.mp4')
    writeFileSync(mediaPath, Buffer.from('not-a-real-video'))
    writeFileSync(join(directory, 'lesson.zh-CN.srt'), '1\n00:00:00,000 --> 00:00:02,000\n已有字幕优先')
    const result = await parseAiDocument(mediaPath, 'mp4')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('已有字幕优先')
    expect(result.sections?.[0].section).toContain('外挂字幕')
  })

  it('recursively parses safe text files from ZIP archives', async () => {
    const filePath = await officeFixture('zip', {
      'docs/readme.md': '# Archive knowledge\nPanLite archive indexing works.',
      'data/info.json': '{"name":"PanLite"}',
    })
    const result = await parseAiDocument(filePath, 'zip')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('Archive knowledge')
    expect(result.sections?.some(section => section.section?.includes('docs/readme.md'))).toBe(true)
  })

  it('provides a compatibility extraction path for legacy Office files', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-legacy-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'legacy.doc')
    writeFileSync(filePath, Buffer.from('Legacy Office readable content\nPanLite compatibility mode', 'utf16le'))
    const result = await parseAiDocument(filePath, 'doc')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('Legacy Office readable content')
  })
})
