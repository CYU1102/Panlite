import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWriteStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decodeXmlText, extractXmlTagText, parseAiDocument } from './document-parser'
import { convertLegacyOfficeLocally, extractEmbeddedSubtitle, ocrImageLocally, ocrPdfLocally, transcribeMediaLocally, withRenderedPdfPage } from './local-ai-tools'
import { extractTextFromVisualFile, getAiProviderConfig, transcribeMediaFile } from './ai-provider'
import { getAiProcessingPolicy } from './processing-policy'

vi.mock('./local-ai-tools', () => ({
  convertLegacyOfficeLocally: vi.fn(), extractEmbeddedSubtitle: vi.fn(), ocrImageLocally: vi.fn(), ocrPdfLocally: vi.fn(), transcribeMediaLocally: vi.fn(), withRenderedPdfPage: vi.fn(),
}))
vi.mock('./processing-policy', () => ({ getAiProcessingPolicy: vi.fn() }))
vi.mock('./ai-provider', () => ({
  getAiProviderConfig: vi.fn(), extractTextFromVisualFile: vi.fn(), transcribeMediaFile: vi.fn(),
}))

const archiver = require('archiver')

const tempDirs: string[] = []

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(convertLegacyOfficeLocally).mockResolvedValue(null)
  vi.mocked(extractEmbeddedSubtitle).mockResolvedValue(null)
  vi.mocked(ocrImageLocally).mockResolvedValue(null)
  vi.mocked(ocrPdfLocally).mockResolvedValue(null)
  vi.mocked(withRenderedPdfPage).mockResolvedValue(null)
  vi.mocked(transcribeMediaLocally).mockResolvedValue(null)
  vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: '', baseUrl: '', transcriptionModel: '' } as ReturnType<typeof getAiProviderConfig>)
  vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: false, useSemanticIndex: false })
})

function textFixture(content: string | Buffer, extension = 'txt'): string {
  const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-text-'))
  tempDirs.push(directory)
  const filePath = join(directory, `fixture.${extension}`)
  writeFileSync(filePath, content)
  return filePath
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function officeFixture(extension: string, entries: Record<string, string | Buffer>): Promise<string> {
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

function pdfFixture(text: string | string[]): string {
  const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-pdf-'))
  tempDirs.push(directory)
  const filePath = join(directory, 'fixture.pdf')
  const pages = Array.isArray(text) ? text : [text]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  for (const [index, content] of pages.entries()) {
    const stream = `BT /F1 18 Tf 72 720 Td (${content.replace(/[()\\]/g, '\\$&')}) Tj ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    )
  }
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

  it('requires a real converter instead of indexing binary strings as legacy Office content', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'panlite-ai-legacy-'))
    tempDirs.push(directory)
    const filePath = join(directory, 'legacy.doc')
    writeFileSync(filePath, Buffer.from('Legacy Office readable content\nPanLite compatibility mode', 'utf16le'))
    const result = await parseAiDocument(filePath, 'doc')
    expect(result.status).toBe('awaiting_parser')
    expect(result.message).toContain('LibreOffice')
    expect(result.preview).toBeUndefined()
  })

  it('parses converted legacy Office content and cleans up the conversion output', async () => {
    const convertedPath = await officeFixture('docx', { 'word/document.xml': '<w:document><w:p><w:r><w:t>Converted content</w:t></w:r></w:p></w:document>' })
    const cleanup = vi.fn()
    vi.mocked(convertLegacyOfficeLocally).mockResolvedValue({ filePath: convertedPath, cleanup })
    const result = await parseAiDocument(textFixture('binary fixture', 'doc'), 'doc')
    expect(result.sections?.[0]).toMatchObject({ section: 'LibreOffice 转换 · 正文', content: 'Converted content' })
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('preserves DOCX spaces, tabs and explicit line breaks across runs', async () => {
    const filePath = await officeFixture('docx', {
      'word/document.xml': '<w:document><w:p><w:r><w:t>One</w:t></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:r><w:t>two</w:t><w:tab/><w:t>three</w:t><w:br/><w:t>four</w:t></w:r></w:p></w:document>',
    })
    expect((await parseAiDocument(filePath, 'docx')).sections?.[0].content).toBe('One two\tthree\nfour')
  })

  it('follows XLSX workbook relationships and preserves sparse columns and literal entities', async () => {
    const filePath = await officeFixture('xlsx', {
      'xl/workbook.xml': '<workbook><sheets><sheet name="第二表" sheetId="9" r:id="rId9"/><sheet name="第一表" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId9" Target="worksheets/sheet9.xml"/><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>&amp;lt;literal&amp;gt;</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet9.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"/><c r="D1" t="inlineStr"><is><t>fourth</t></is></c><c r="E1" t="b"><v>1</v></c><c r="F1"><f>1+1</f></c></row></sheetData></worksheet>',
    })
    const result = await parseAiDocument(filePath, 'xlsx')
    expect(result.sections?.map(section => section.section)).toEqual(['工作表：第二表', '工作表：第一表'])
    expect(result.sections?.[0].content).toBe('&lt;literal&gt;\t\t\tfourth\tTRUE\t=1+1 [公式未计算]')
    expect(result.message).toContain('未重新计算')
  })

  it('reads prefixed XLSX elements with single-quoted attributes', async () => {
    const filePath = await officeFixture('xlsx', {
      'xl/worksheets/sheet1.xml': "<x:worksheet><x:sheetData><x:row r='1'><x:c r='C1' t='inlineStr'><x:is><x:t>文本</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>",
    })
    expect((await parseAiDocument(filePath, 'xlsx')).sections?.[0].content).toBe('\t\t文本')
  })

  it('follows PPTX slide and note relationships instead of numerical filenames', async () => {
    const filePath = await officeFixture('pptx', {
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="2" r:id="rId2"/><p:sldId id="1" r:id="rId1"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide2.xml"/><Relationship Id="rId1" Target="slides/slide1.xml"/></Relationships>',
      'ppt/slides/slide1.xml': '<p:sld><a:p><a:r><a:t>Last slide</a:t></a:r></a:p></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>First</a:t></a:r><a:r><a:t> slide</a:t></a:r></a:p></p:sld>',
      'ppt/slides/_rels/slide2.xml.rels': '<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide8.xml"/></Relationships>',
      'ppt/notesSlides/notesSlide8.xml': '<p:notes><p:sp><a:t>2026</a:t></p:sp><p:sp><p:nvPr><p:ph type="sldNum"/></p:nvPr><a:t>99</a:t></p:sp></p:notes>',
    })
    const result = await parseAiDocument(filePath, 'pptx')
    expect(result.sections?.[0]).toMatchObject({ pageNumber: 1, content: 'First slide\n\n备注：\n2026' })
    expect(result.sections?.[1].content).toBe('Last slide')
  })

  it.each([
    ['UTF-16LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文和 English', 'utf16le')])],
    ['UTF-16BE', Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('中文和 English', 'utf16le').swap16()])],
    ['GB18030', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])],
  ])('decodes %s text without replacement characters', async (_name, bytes) => {
    const result = await parseAiDocument(textFixture(bytes), 'TXT')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('中文')
    expect(result.preview).not.toContain('�')
  })

  it('reports truncation rather than silently presenting a full-file index', async () => {
    const result = await parseAiDocument(textFixture('a'.repeat(2 * 1024 * 1024 + 10)), 'txt')
    expect(result.status).toBe('ready')
    expect(result.message).toContain('前 2 MB')
    expect(result.preview).toContain('后续内容未索引')
    expect(result.coverage).toMatchObject({ unit: 'bytes', parsedUnits: 2 * 1024 * 1024, sourceUnits: 2 * 1024 * 1024 + 10, sourceComplete: false, partial: true })
  })

  it('returns structured failure for missing and empty text files', async () => {
    expect((await parseAiDocument(textFixture(''), 'txt')).status).toBe('failed')
    expect((await parseAiDocument(join(tmpdir(), 'nonexistent-panlite-parser-file.txt'), 'txt')).status).toBe('failed')
  })

  it('ignores WebVTT metadata, cue IDs and settings while preserving cue text and times', async () => {
    const filePath = textFixture('WEBVTT\n\nNOTE developer metadata\nDo not index this\n\nSTYLE\n::cue { color: red }\n\nintro-cue\n00:01.000 --> 00:03.000 align:start position:10%\n<v Alice>Hello &amp; <b>world</b>\n', 'vtt')
    const result = await parseAiDocument(filePath, 'vtt')
    expect(result.sections).toEqual([{ section: '00:01.000 → 00:03.000', content: 'Hello & world', startSeconds: 1, endSeconds: 3 }])
  })

  it('honors ASS event format and does not invent text for empty dialogue', async () => {
    const filePath = textFixture('[Events]\nFormat: Start, End, Style, Text\nDialogue: 0:00:01.00,0:00:03.00,Default,{\\b1}First\\NSecond, comma\\hspace\nDialogue: 0:00:04.00,0:00:05.00,Default,{\\b1}', 'ass')
    const result = await parseAiDocument(filePath, 'ass')
    expect(result.sections).toEqual([{ section: '0:00:01.00 → 0:00:03.00', content: 'First\nSecond, comma space', startSeconds: 1, endSeconds: 3 }])
  })

  it('falls back from empty sidecar to embedded subtitles and parses its cue times', async () => {
    const mediaPath = textFixture('fixture', 'mp4')
    writeFileSync(mediaPath.replace(/mp4$/, 'srt'), '')
    vi.mocked(extractEmbeddedSubtitle).mockResolvedValue('00:00:01.000 --> 00:00:03.000\nInner subtitle')
    const result = await parseAiDocument(mediaPath, 'mp4')
    expect(result.sections).toEqual([{ section: 'FFmpeg 内嵌字幕 · 00:00:01.000 → 00:00:03.000', content: 'Inner subtitle', startSeconds: 1, endSeconds: 3 }])
    expect(transcribeMediaLocally).not.toHaveBeenCalled()
  })

  it('preserves Whisper subtitle segment times without indexing cue numbers as text', async () => {
    vi.mocked(transcribeMediaLocally).mockResolvedValue('1\n00:00:12,500 --> 00:00:15,000\nOpening evidence\n\n2\n00:01:01,000 --> 00:01:04,200\nLater evidence')
    const result = await parseAiDocument(textFixture('fixture', 'mp4'), 'mp4')
    expect(result.sections).toEqual([
      { section: '本地 Whisper 转写 · 00:00:12,500 → 00:00:15,000', content: 'Opening evidence', startSeconds: 12.5, endSeconds: 15 },
      { section: '本地 Whisper 转写 · 00:01:01,000 → 00:01:04,200', content: 'Later evidence', startSeconds: 61, endSeconds: 64.2 },
    ])
    expect(transcribeMediaFile).not.toHaveBeenCalled()
  })

  it('keeps legacy untimed transcription usable without inventing a seek time', async () => {
    vi.mocked(transcribeMediaLocally).mockResolvedValue('Legacy transcript without segment times')
    expect((await parseAiDocument(textFixture('fixture', 'wav'), 'wav')).sections).toEqual([
      { section: '本地 Whisper 转写', content: 'Legacy transcript without segment times' },
    ])
  })

  it('uses transcription configuration independently of the chat model', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-responses', model: '', baseUrl: 'https://example.invalid/v1', transcriptionModel: 'transcriber' } as ReturnType<typeof getAiProviderConfig>)
    vi.mocked(transcribeMediaFile).mockResolvedValue('Transcription result')
    const result = await parseAiDocument(textFixture('fixture', 'wav'), 'wav')
    expect(result.status).toBe('ready')
    expect(result.preview).toContain('Transcription result')
  })

  it('does not invoke unsupported cloud transcription protocols', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'anthropic', model: 'chat', baseUrl: 'https://example.invalid', transcriptionModel: 'transcriber' } as ReturnType<typeof getAiProviderConfig>)
    expect((await parseAiDocument(textFixture('fixture', 'wav'), 'wav')).status).toBe('awaiting_parser')
    expect(transcribeMediaFile).not.toHaveBeenCalled()
  })

  it('uses local OCR first and reports missing dependencies honestly', async () => {
    const filePath = textFixture('fixture', 'png')
    expect((await parseAiDocument(filePath, 'png')).status).toBe('awaiting_parser')
    vi.mocked(ocrImageLocally).mockResolvedValue('Recognized text')
    expect((await parseAiDocument(filePath, 'png')).sections?.[0].content).toBe('Recognized text')
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
  })

  it('does not send scanned PDF files to Ollama', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'ollama', model: 'vision', baseUrl: 'http://localhost:11434' } as ReturnType<typeof getAiProviderConfig>)
    const result = await parseAiDocument(pdfFixture(''), 'pdf')
    expect(result.status).toBe('awaiting_parser')
    expect(result.message).toContain('Ollama')
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
  })

  it('discloses unsupported members of a partially parsed archive', async () => {
    const filePath = await officeFixture('zip', { 'readme.txt': 'Supported text', 'drawing.unknown': 'Unsupported content' })
    const result = await parseAiDocument(filePath, 'zip')
    expect(result.status).toBe('ready')
    expect(result.message).toContain('1 个文件')
    expect(result.message).toContain('部分')
    expect(result.partial).toBe(true)
  })

  it('propagates incomplete nested archives to the outer archive', async () => {
    const inner = await officeFixture('zip', { 'readme.txt': 'Nested text', 'unsupported.abc': 'Unsupported' })
    const outer = await officeFixture('zip', { 'nested.zip': readFileSync(inner) })
    const result = await parseAiDocument(outer, 'zip')
    expect(result.status).toBe('ready')
    expect(result.partial).toBe(true)
    expect(result.preview).toContain('nested.zip · readme.txt')
    expect(result.message).toContain('部分')
  })

  it.each(['tar', 'tgz', '7z'])('indexes a real %s archive using its bundled extractor', async extension => {
    const source = textFixture('Archive extraction accuracy')
    const directory = dirname(source)
    const filePath = join(directory, `archive.${extension}`)
    if (extension === '7z') {
      execFileSync(require('7zip-bin').path7za, ['a', filePath, 'fixture.txt'], { cwd: directory, windowsHide: true })
    } else {
      await require('tar').create({ file: filePath, cwd: directory, gzip: extension === 'tgz' }, ['fixture.txt'])
    }
    const result = await parseAiDocument(filePath, extension)
    expect(result.status).toBe('ready')
    expect(result.sections?.[0]).toMatchObject({ section: 'fixture.txt · 正文', content: 'Archive extraction accuracy' })
  })

  it('does not fall back to a remote model after cancellation of local OCR', async () => {
    const controller = new AbortController()
    vi.mocked(ocrImageLocally).mockImplementation(async () => { controller.abort(); throw new Error('cancelled') })
    const result = await parseAiDocument(textFixture('fixture', 'png'), 'png', { signal: controller.signal })
    expect(result.status).toBe('failed')
    expect(result.message).toContain('取消')
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
  })

  it.each(['png', 'mp4', 'pdf'])('does not use a configured model for %s unless fallback is explicitly enabled', async extension => {
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1', transcriptionModel: 'configured-transcriber' } as ReturnType<typeof getAiProviderConfig>)
    const filePath = extension === 'pdf' ? pdfFixture('') : textFixture('fixture', extension)
    const result = await parseAiDocument(filePath, extension)
    expect(result.status).toBe('awaiting_parser')
    expect(result.message).toContain('模型补充识别默认关闭')
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
    expect(transcribeMediaFile).not.toHaveBeenCalled()
    expect(getAiProviderConfig).not.toHaveBeenCalled()
  })

  it('does not use models when text, Office, PDF text layers or subtitles already provide content', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: true })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1', transcriptionModel: 'configured-transcriber' } as ReturnType<typeof getAiProviderConfig>)
    const docx = await officeFixture('docx', { 'word/document.xml': '<w:document><w:p><w:r><w:t>Native Office text</w:t></w:r></w:p></w:document>' })
    for (const [filePath, extension] of [[textFixture('Native text'), 'txt'], [docx, 'docx'], [pdfFixture('Native PDF text'), 'pdf'], [textFixture('1\n00:00:01,000 --> 00:00:03,000\nNative subtitle', 'srt'), 'srt']]) {
      expect((await parseAiDocument(filePath, extension)).status).toBe('ready')
    }
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
    expect(transcribeMediaFile).not.toHaveBeenCalled()
    expect(ocrPdfLocally).not.toHaveBeenCalled()
    expect(getAiProviderConfig).not.toHaveBeenCalled()
  })

  it('uses local PDF OCR only for missing pages and never overwrites existing text or page numbers', async () => {
    const filePath = pdfFixture(['First native page', '', 'Last native page'])
    vi.mocked(ocrPdfLocally).mockResolvedValue([{ pageNumber: 1, content: 'Do not overwrite' }, { pageNumber: 2, content: 'Scanned middle page' }, { pageNumber: 99, content: 'Out of range' }])
    const result = await parseAiDocument(filePath, 'pdf')
    expect(ocrPdfLocally).toHaveBeenCalledWith(filePath, undefined, [2])
    expect(result.status).toBe('ready')
    expect(result.partial).toBe(false)
    expect(result.sections?.map(section => [section.pageNumber, section.content])).toEqual([[1, 'First native page'], [2, 'Scanned middle page'], [3, 'Last native page']])
    expect(result.message).toContain('本地 OCR 补充 1 页')
    expect(withRenderedPdfPage).not.toHaveBeenCalled()
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
  })

  it('retains partial native PDF content and local OCR diagnostics without default model fallback', async () => {
    vi.mocked(ocrPdfLocally).mockRejectedValue(new Error('缺少 chi_sim 语言包'))
    const result = await parseAiDocument(pdfFixture(['Native page', '']), 'pdf')
    expect(result).toMatchObject({ status: 'ready', partial: true })
    expect(result.sections?.map(section => section.pageNumber)).toEqual([1])
    expect(result.message).toContain('1 页为空白或尚未识别')
    expect(result.message).toContain('缺少 chi_sim 语言包')
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
  })

  it('recognizes a scanned PDF locally with its original page numbers', async () => {
    vi.mocked(ocrPdfLocally).mockResolvedValue([{ pageNumber: 1, content: '扫描页一' }, { pageNumber: 2, content: '扫描页二' }])
    const result = await parseAiDocument(pdfFixture(['', '']), 'pdf')
    expect(result).toMatchObject({ status: 'ready', partial: false })
    expect(result.sections?.map(section => [section.pageNumber, section.content])).toEqual([[1, '扫描页一'], [2, '扫描页二']])
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
  })

  it('sends only still-missing PDF page images to an explicitly enabled model', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1' } as ReturnType<typeof getAiProviderConfig>)
    vi.mocked(ocrPdfLocally).mockResolvedValue([{ pageNumber: 2, content: 'Local OCR second page' }])
    vi.mocked(withRenderedPdfPage).mockImplementation(async (_filePath, pageNumber, callback) => callback(`synthetic-page-${pageNumber}.png`, new AbortController().signal))
    vi.mocked(extractTextFromVisualFile).mockResolvedValue('Model OCR third page')
    const filePath = pdfFixture(['Native first page', '', ''])
    const result = await parseAiDocument(filePath, 'pdf')
    expect(result).toMatchObject({ status: 'ready', partial: false })
    expect(withRenderedPdfPage).toHaveBeenCalledOnce()
    expect(withRenderedPdfPage).toHaveBeenCalledWith(filePath, 3, expect.any(Function), undefined)
    expect(extractTextFromVisualFile).toHaveBeenCalledWith('synthetic-page-3.png', 'image/png', expect.any(AbortSignal))
    expect(result.sections?.map(section => [section.pageNumber, section.content])).toEqual([[1, 'Native first page'], [2, 'Local OCR second page'], [3, 'Model OCR third page']])
  })

  it('does not send a mixed PDF as a whole when page rendering is unavailable', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1' } as ReturnType<typeof getAiProviderConfig>)
    const result = await parseAiDocument(pdfFixture(['Already extracted native text', '']), 'pdf')
    expect(result).toMatchObject({ status: 'ready', partial: true })
    expect(result.message).toContain('不会把已有解析内容的 PDF 整份发送给模型')
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
  })

  it('marks whole-file model OCR of an opted-in scanned PDF as unverified page mapping', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1' } as ReturnType<typeof getAiProviderConfig>)
    vi.mocked(extractTextFromVisualFile).mockResolvedValue('Unsegmented scanned document text')
    const filePath = pdfFixture(['', ''])
    const result = await parseAiDocument(filePath, 'pdf')
    expect(result).toMatchObject({ status: 'ready', partial: true })
    expect(result.sections?.[0].pageNumber).toBeUndefined()
    expect(result.message).toContain('无法确认结果的逐页对应及完整性')
    expect(extractTextFromVisualFile).toHaveBeenCalledWith(filePath, 'application/pdf', undefined)
  })

  it('allows explicitly enabled image fallback only after local OCR did not produce text', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1' } as ReturnType<typeof getAiProviderConfig>)
    vi.mocked(extractTextFromVisualFile).mockResolvedValue('Model recognized image')
    const filePath = textFixture('fixture', 'png')
    expect((await parseAiDocument(filePath, 'png')).status).toBe('ready')
    expect(ocrImageLocally).toHaveBeenCalledWith(filePath, undefined)
    expect(extractTextFromVisualFile).toHaveBeenCalledWith(filePath, 'image/png', undefined)
  })

  it('keeps locally transcribed media local even when a fallback model is configured', async () => {
    vi.mocked(getAiProcessingPolicy).mockReturnValue({ allowModelFallback: true, useSemanticIndex: false })
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1', transcriptionModel: 'configured-transcriber' } as ReturnType<typeof getAiProviderConfig>)
    vi.mocked(transcribeMediaLocally).mockResolvedValue('Local transcript')
    expect((await parseAiDocument(textFixture('fixture', 'wav'), 'wav')).sections?.[0].content).toBe('Local transcript')
    expect(transcribeMediaFile).not.toHaveBeenCalled()
  })

  it('applies the default no-model policy recursively inside nested archives', async () => {
    vi.mocked(getAiProviderConfig).mockReturnValue({ type: 'openai-compatible', model: 'configured-vision', baseUrl: 'https://example.invalid/v1', transcriptionModel: 'configured-transcriber' } as ReturnType<typeof getAiProviderConfig>)
    const inner = await officeFixture('zip', { 'notes.txt': 'Native archived text', 'image.png': 'fixture image', 'movie.mp4': 'fixture media', 'scan.pdf': readFileSync(pdfFixture('')) })
    const outer = await officeFixture('zip', { 'nested.zip': readFileSync(inner) })
    const result = await parseAiDocument(outer, 'zip')
    expect(result).toMatchObject({ status: 'ready', partial: true })
    expect(result.preview).toContain('Native archived text')
    expect(extractTextFromVisualFile).not.toHaveBeenCalled()
    expect(transcribeMediaFile).not.toHaveBeenCalled()
  })
})
