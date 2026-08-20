import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import PDFParser, { type Output as PdfOutput, type Text as PdfText } from 'pdf2json'
import type { AiDocumentStatus } from '../../shared/ai-types'
import { cleanupTempDir, extractArchive, getAllFilesInDir, isSupportedArchive, listArchiveFiles } from '../archive'
import { extractTextFromVisualFile, getAiProviderConfig, transcribeMediaFile } from './ai-provider'
import { convertLegacyOfficeLocally, extractEmbeddedSubtitle, ocrImageLocally, transcribeMediaLocally } from './local-ai-tools'

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024
const MAX_XML_ENTRY_SIZE = 20 * 1024 * 1024
const MAX_TOTAL_XML_SIZE = 60 * 1024 * 1024
const MAX_PDF_SIZE = 200 * 1024 * 1024
const MAX_PDF_PAGES = 1_000
const PDF_PARSE_TIMEOUT_MS = 90_000
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'yaml', 'yml', 'log',
  'html', 'htm', 'js', 'ts', 'java', 'py', 'sql', 'ini', 'properties',
])
const SUBTITLE_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa', 'lrc'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp'])
const MEDIA_EXTENSIONS = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'mp4', 'mkv', 'avi', 'mov', 'webm', 'mpeg', 'mpga'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz'])
const LEGACY_OFFICE_EXTENSIONS = new Set(['doc', 'xls', 'ppt'])
const AI_ARCHIVE_MAX_ENTRIES = 500
const AI_ARCHIVE_MAX_TOTAL_SIZE = 256 * 1024 * 1024
const AI_ARCHIVE_MAX_FILE_SIZE = 50 * 1024 * 1024
const AI_ARCHIVE_MAX_DEPTH = 2
const ADVANCED_EXTENSIONS = new Set([
  ...LEGACY_OFFICE_EXTENSIONS, ...IMAGE_EXTENSIONS, ...MEDIA_EXTENSIONS, ...ARCHIVE_EXTENSIONS,
])

export interface AiParseResult {
  status: AiDocumentStatus
  preview?: string
  sections?: AiParsedSection[]
  message: string
}

export interface AiParsedSection {
  content: string
  pageNumber?: number
  section?: string
}

type ZipEntry = {
  path: string
  type: string
  size?: number
  buffer: () => Promise<Buffer>
}

export function decodeXmlText(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_match, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export function extractXmlTagText(xml: string, tagPattern = '(?:w:|a:)?t'): string[] {
  const values: string[] = []
  const regex = new RegExp(`<${tagPattern}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tagPattern}>`, 'gi')
  for (const match of xml.matchAll(regex)) {
    const text = decodeXmlText(match[1].replace(/<[^>]+>/g, ''))
    if (text.trim()) values.push(text)
  }
  return values
}

function clipPreview(text: string): string {
  return text.length > TEXT_PREVIEW_LIMIT ? `${text.slice(0, TEXT_PREVIEW_LIMIT)}\n\n[内容过长，预览已截断]` : text
}

function readTextPreview(filePath: string): string {
  const fd = fs.openSync(filePath, 'r')
  try {
    const buffer = Buffer.alloc(TEXT_PREVIEW_LIMIT)
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytes).toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

async function openOfficeEntries(filePath: string): Promise<ZipEntry[]> {
  const unzipper = require('unzipper')
  const directory = await unzipper.Open.file(filePath)
  return directory.files as ZipEntry[]
}

async function readXmlEntry(entry: ZipEntry, budget: { total: number }): Promise<string> {
  const declaredSize = Number(entry.size || 0)
  if (declaredSize > MAX_XML_ENTRY_SIZE) throw new Error(`Office XML 条目过大: ${entry.path}`)
  budget.total += declaredSize
  if (budget.total > MAX_TOTAL_XML_SIZE) throw new Error('Office 文档展开后的 XML 总量超过安全限制')
  const buffer = await entry.buffer()
  if (buffer.length > MAX_XML_ENTRY_SIZE) throw new Error(`Office XML 条目过大: ${entry.path}`)
  return buffer.toString('utf8')
}

function numericSuffix(entryPath: string): number {
  return Number(entryPath.match(/(\d+)\.xml$/)?.[1] || Number.MAX_SAFE_INTEGER)
}

async function parseDocx(filePath: string): Promise<AiParsedSection[]> {
  const entries = await openOfficeEntries(filePath)
  const selected = entries
    .filter(entry => entry.type !== 'Directory' && /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/i.test(entry.path))
    .sort((left, right) => left.path.localeCompare(right.path))
  if (!selected.length) throw new Error('DOCX 中没有找到正文 XML')
  const budget = { total: 0 }
  const sections: AiParsedSection[] = []
  for (const entry of selected) {
    const xml = await readXmlEntry(entry, budget)
    const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gi)]
      .map(match => extractXmlTagText(match[1], 'w:t').join(''))
      .filter(Boolean)
    if (paragraphs.length) sections.push({
      section: entry.path === 'word/document.xml' ? '正文' : entry.path.replace(/^word\//, '').replace(/\.xml$/i, ''),
      content: paragraphs.join('\n'),
    })
  }
  return sections
}

async function parseXlsx(filePath: string): Promise<AiParsedSection[]> {
  const entries = await openOfficeEntries(filePath)
  const budget = { total: 0 }
  const sharedEntry = entries.find(entry => entry.path === 'xl/sharedStrings.xml')
  const sharedStrings: string[] = []
  if (sharedEntry) {
    const xml = await readXmlEntry(sharedEntry, budget)
    for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/gi)) {
      sharedStrings.push(extractXmlTagText(match[1], '(?:x:)?t').join(''))
    }
  }

  const workbookEntry = entries.find(entry => entry.path === 'xl/workbook.xml')
  const sheetNames: string[] = []
  if (workbookEntry) {
    const workbookXml = await readXmlEntry(workbookEntry, budget)
    for (const match of workbookXml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*>/gi)) sheetNames.push(decodeXmlText(match[1]))
  }

  const sheets = entries
    .filter(entry => entry.type !== 'Directory' && /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.path))
    .sort((left, right) => numericSuffix(left.path) - numericSuffix(right.path))
  if (!sheets.length) throw new Error('XLSX 中没有找到工作表')
  const sections: AiParsedSection[] = []
  for (let index = 0; index < sheets.length; index++) {
    const xml = await readXmlEntry(sheets[index], budget)
    const rows: string[] = []
    for (const rowMatch of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/gi)) {
      const cells: string[] = []
      for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
        const attributes = cellMatch[1]
        const body = cellMatch[2]
        const type = attributes.match(/\bt="([^"]+)"/i)?.[1] || ''
        let value = body.match(/<v>([\s\S]*?)<\/v>/i)?.[1] || ''
        if (type === 's') value = sharedStrings[Number(value)] || value
        else if (type === 'inlineStr') value = extractXmlTagText(body, '(?:x:)?t').join('')
        cells.push(decodeXmlText(value).trim())
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'))
    }
    const sheetName = sheetNames[index] || `Sheet ${index + 1}`
    sections.push({ section: `工作表：${sheetName}`, content: rows.join('\n') })
  }
  return sections
}

async function parsePptx(filePath: string): Promise<AiParsedSection[]> {
  const entries = await openOfficeEntries(filePath)
  const budget = { total: 0 }
  const slides = entries
    .filter(entry => entry.type !== 'Directory' && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.path))
    .sort((left, right) => numericSuffix(left.path) - numericSuffix(right.path))
  if (!slides.length) throw new Error('PPTX 中没有找到幻灯片')
  const notes = new Map<number, ZipEntry>()
  for (const entry of entries) {
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry.path)) notes.set(numericSuffix(entry.path), entry)
  }
  const sections: AiParsedSection[] = []
  for (let index = 0; index < slides.length; index++) {
    const number = numericSuffix(slides[index].path)
    const slideXml = await readXmlEntry(slides[index], budget)
    const lines = extractXmlTagText(slideXml, 'a:t')
    let content = lines.join('\n')
    const noteEntry = notes.get(number)
    if (noteEntry) {
      const noteXml = await readXmlEntry(noteEntry, budget)
      const noteLines = extractXmlTagText(noteXml, 'a:t').filter(line => !/^\d+$/.test(line))
      if (noteLines.length) content += `\n\n备注：\n${noteLines.join('\n')}`
    }
    sections.push({ section: `幻灯片 ${index + 1}`, pageNumber: index + 1, content })
  }
  return sections
}

function decodePdfText(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function textBlockValue(block: PdfText): string {
  return block.R.map(run => decodePdfText(run.T || '')).join('')
}

function extractPdfPageText(texts: PdfText[]): string {
  const sorted = [...texts].sort((left, right) => {
    const rowDelta = left.y - right.y
    return Math.abs(rowDelta) > 0.18 ? rowDelta : left.x - right.x
  })
  const lines: string[] = []
  let currentY: number | undefined
  let current = ''
  for (const block of sorted) {
    const value = textBlockValue(block).trim()
    if (!value) continue
    if (currentY === undefined || Math.abs(block.y - currentY) <= 0.18) {
      current += `${current ? ' ' : ''}${value}`
    } else {
      if (current.trim()) lines.push(current.trim())
      current = value
    }
    currentY = block.y
  }
  if (current.trim()) lines.push(current.trim())
  return lines.join('\n')
}

async function parsePdf(filePath: string): Promise<AiParsedSection[]> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_PDF_SIZE) throw new Error('PDF 超过 200 MB 安全解析限制')
  const parser = new PDFParser(null, true)
  const output = await new Promise<PdfOutput>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      callback()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('PDF 解析超时'))), PDF_PARSE_TIMEOUT_MS)
    parser.on('pdfParser_dataReady', data => finish(() => resolve(data)))
    parser.on('pdfParser_dataError', error => finish(() => {
      const cause = 'parserError' in error ? error.parserError : error
      reject(cause instanceof Error ? cause : new Error(String(cause)))
    }))
    parser.loadPDF(filePath, 0).catch(error => finish(() => reject(error)))
  })
  try {
    if (output.Pages.length > MAX_PDF_PAGES) throw new Error(`PDF 页数超过 ${MAX_PDF_PAGES} 页安全限制`)
    return output.Pages.map((page, index) => ({
      pageNumber: index + 1,
      section: `第 ${index + 1} 页`,
      content: extractPdfPageText(page.Texts || []),
    })).filter(section => section.content.trim())
  } finally {
    parser.destroy()
  }
}

function previewFromSections(sections: AiParsedSection[]): string {
  return clipPreview(sections.map(section => {
    const label = section.pageNumber ? `第 ${section.pageNumber} 页` : section.section
    return `${label ? `# ${label}\n` : ''}${section.content}`
  }).join('\n\n'))
}

function parseSubtitle(filePath: string, extension: string): AiParsedSection[] {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  if (extension === 'lrc') {
    return content.split(/\r?\n/).map((line, index) => {
      const match = line.match(/^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/)
      return match ? { section: match[1], content: match[2].trim() } : { section: `第 ${index + 1} 行`, content: line.trim() }
    }).filter(item => item.content)
  }
  if (extension === 'ass' || extension === 'ssa') {
    return content.split(/\r?\n/).filter(line => /^Dialogue:/i.test(line)).map((line, index) => {
      const fields = line.replace(/^Dialogue:\s*/i, '').split(',')
      const start = fields[1] || ''
      const end = fields[2] || ''
      return { section: `${start} → ${end}`, content: fields.slice(9).join(',').replace(/\\N/g, '\n').replace(/\{[^}]*\}/g, '').trim() || `字幕 ${index + 1}` }
    }).filter(item => item.content)
  }
  const normalized = content.replace(/^WEBVTT[^\n]*\n/i, '')
  return normalized.split(/\r?\n\s*\r?\n/).map((block, index) => {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (/^\d+$/.test(lines[0] || '')) lines.shift()
    const timing = lines[0]?.match(/^(.*?)\s*-->\s*(.*?)(?:\s+\S+=.*)?$/)
    if (timing) lines.shift()
    return { section: timing ? `${timing[1]} → ${timing[2]}` : `字幕 ${index + 1}`, content: lines.join('\n').replace(/<[^>]+>/g, '').trim() }
  }).filter(item => item.content)
}

function findSidecarSubtitle(mediaPath: string): { filePath: string; extension: string } | null {
  const parsed = path.parse(mediaPath)
  for (const extension of SUBTITLE_EXTENSIONS) {
    const candidates = [
      path.join(parsed.dir, `${parsed.name}.${extension}`),
      path.join(parsed.dir, `${parsed.name}.zh-CN.${extension}`),
      path.join(parsed.dir, `${parsed.name}.zh.${extension}`),
    ]
    const match = candidates.find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    if (match) return { filePath: match, extension }
  }
  return null
}

function parseLegacyOffice(filePath: string): AiParsedSection[] {
  const buffer = fs.readFileSync(filePath)
  if (buffer.length > 100 * 1024 * 1024) throw new Error('旧版 Office 文件超过 100 MB 解析限制')
  const values: string[] = []
  const seen = new Set<string>()
  const accept = (value: string) => {
    const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim()
    if (cleaned.length < 3 || seen.has(cleaned) || !/[\p{L}\p{N}\u3400-\u9fff]/u.test(cleaned)) return
    seen.add(cleaned)
    values.push(cleaned)
  }
  for (const match of buffer.toString('utf16le').matchAll(/[\p{L}\p{N}\p{P}\p{Zs}\u3400-\u9fff]{3,}/gu)) accept(match[0])
  for (const match of buffer.toString('latin1').matchAll(/[\x20-\x7e]{4,}/g)) accept(match[0])
  if (!values.length) throw new Error('未能从旧版 Office 文件中提取文字，建议另存为 DOCX/XLSX/PPTX')
  return [{ section: '旧版 Office 文本', content: values.slice(0, 20_000).join('\n') }]
}

function mimeForExtension(extension: string): string {
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', webm: 'video/webm',
    pdf: 'application/pdf',
  }
  return types[extension] || 'application/octet-stream'
}

async function parseArchiveDocument(filePath: string, depth: number, signal?: AbortSignal): Promise<AiParsedSection[]> {
  if (depth >= AI_ARCHIVE_MAX_DEPTH) throw new Error(`压缩包递归层级超过 ${AI_ARCHIVE_MAX_DEPTH} 层限制`)
  const meta = await listArchiveFiles(filePath)
  const files = meta.files.filter(item => !item.isDir)
  if (files.length > AI_ARCHIVE_MAX_ENTRIES) throw new Error(`用于 AI 解析的文件数量不能超过 ${AI_ARCHIVE_MAX_ENTRIES}`)
  const total = files.reduce((sum, item) => sum + item.size, 0)
  if (total > AI_ARCHIVE_MAX_TOTAL_SIZE) throw new Error('用于 AI 解析的解压后内容不能超过 256 MB')
  const selected = files.filter(item => item.size <= AI_ARCHIVE_MAX_FILE_SIZE).map(item => item.path)
  if (!selected.length) throw new Error('压缩包中没有可安全解析的文件')
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-ai-archive-'))
  try {
    await extractArchive(filePath, outputDir, undefined, selected, { signal })
    const extracted = getAllFilesInDir(outputDir).slice(0, AI_ARCHIVE_MAX_ENTRIES)
    const sections: AiParsedSection[] = []
    for (const file of extracted) {
      if (sections.length >= 2_000) break
      const extension = path.extname(file.relativePath).slice(1).toLowerCase()
      if (!extension || file.size > AI_ARCHIVE_MAX_FILE_SIZE) continue
      const result = await parseAiDocument(file.fullPath, extension, { archiveDepth: depth + 1, signal })
      if (result.status !== 'ready' || !result.sections?.length) continue
      for (const section of result.sections) sections.push({
        pageNumber: section.pageNumber,
        section: `${file.relativePath}${section.section ? ` · ${section.section}` : ''}`,
        content: section.content,
      })
    }
    if (!sections.length) throw new Error('压缩包中没有提取到可索引文字')
    return sections
  } finally {
    cleanupTempDir(outputDir)
  }
}

export async function parseAiDocument(filePath: string, extension: string, options: { archiveDepth?: number; signal?: AbortSignal } = {}): Promise<AiParseResult> {
  if (TEXT_EXTENSIONS.has(extension)) {
    const content = readTextPreview(filePath)
    return { status: 'ready', preview: content, sections: [{ section: '正文', content }], message: '文本已提取并建立本地索引' }
  }
  try {
    let sections: AiParsedSection[] = []
    if (extension === 'pdf') sections = await parsePdf(filePath)
    else if (extension === 'docx') sections = await parseDocx(filePath)
    else if (extension === 'xlsx') sections = await parseXlsx(filePath)
    else if (extension === 'pptx') sections = await parsePptx(filePath)
    else if (SUBTITLE_EXTENSIONS.has(extension)) sections = parseSubtitle(filePath, extension)
    else if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
      const converted = await convertLegacyOfficeLocally(filePath, extension, options.signal)
      if (converted) {
        try {
          const convertedExtension = path.extname(converted.filePath).slice(1).toLowerCase()
          const result = await parseAiDocument(converted.filePath, convertedExtension, options)
          if (result.status === 'ready' && result.sections) sections = result.sections.map(section => ({ ...section, section: `LibreOffice 转换 · ${section.section || ''}` }))
          else throw new Error(result.message)
        } finally { converted.cleanup() }
      } else sections = parseLegacyOffice(filePath)
    }
    else if (IMAGE_EXTENSIONS.has(extension)) {
      let content: string | null = null
      try { content = await ocrImageLocally(filePath, options.signal) } catch { /* fall back to configured model */ }
      if (content) sections = [{ section: '本地 Tesseract OCR', content }]
      else {
        if (!getAiProviderConfig().model) return { status: 'awaiting_parser', message: '图片已导入；安装 Tesseract 或配置视觉模型后重新解析即可 OCR' }
        content = await extractTextFromVisualFile(filePath, mimeForExtension(extension))
        sections = [{ section: '视觉模型 OCR', content }]
      }
    }
    else if (MEDIA_EXTENSIONS.has(extension)) {
      const sidecar = findSidecarSubtitle(filePath)
      if (sidecar) {
        sections = parseSubtitle(sidecar.filePath, sidecar.extension).map(section => ({ ...section, section: `外挂字幕 · ${section.section || ''}` }))
      }
      else {
        let embeddedSubtitle: string | null = null
        try { embeddedSubtitle = await extractEmbeddedSubtitle(filePath, options.signal) } catch { /* image subtitles may not be text-extractable */ }
        if (embeddedSubtitle) sections = [{ section: 'FFmpeg 内嵌字幕', content: embeddedSubtitle }]
        else {
          let localTranscript: string | null = null
          try { localTranscript = await transcribeMediaLocally(filePath, options.signal) } catch { /* fall back to remote transcription */ }
          if (localTranscript) sections = [{ section: '本地 Whisper 转写', content: localTranscript }]
          else {
            if (!getAiProviderConfig().model) return { status: 'awaiting_parser', message: '未发现字幕；安装 FFmpeg + Whisper 或配置转写模型后重新解析' }
            const content = await transcribeMediaFile(filePath, mimeForExtension(extension))
            sections = [{ section: '云端语音转写', content }]
          }
        }
      }
    }
    else if (ARCHIVE_EXTENSIONS.has(extension) && isSupportedArchive(filePath)) sections = await parseArchiveDocument(filePath, options.archiveDepth || 0, options.signal)
    else if (ADVANCED_EXTENSIONS.has(extension)) return { status: 'awaiting_parser', message: '文件已导入，等待对应解析能力' }
    else return { status: 'unsupported', message: '暂不支持该文件类型' }

    if (!sections.some(section => section.content.trim())) {
      if (extension === 'pdf') {
        if (!getAiProviderConfig().model) return { status: 'awaiting_parser', message: 'PDF 未检测到文本层，配置支持文件输入的 AI 模型后重新解析即可 OCR' }
        try {
          const content = await extractTextFromVisualFile(filePath, 'application/pdf')
          sections = [{ section: '扫描 PDF OCR', content }]
        } catch (error) {
          return { status: 'awaiting_parser', message: `扫描 PDF OCR 暂不可用：${error instanceof Error ? error.message : String(error)}` }
        }
      }
      if (sections.some(section => section.content.trim())) {
        return { status: 'ready', preview: previewFromSections(sections), sections, message: '文件内容已提取并建立本地索引' }
      }
      return { status: 'failed', message: '文件中没有提取到可用文本' }
    }
    return {
      status: 'ready',
      preview: previewFromSections(sections),
      sections,
      message: extension === 'pdf' ? `PDF 文本已按 ${sections.length} 页提取并建立索引` : 'Office 内容已提取并建立本地索引',
    }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
