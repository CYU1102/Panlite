import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import PDFParser, { type Output as PdfOutput } from 'pdf2json'
import type { AiDocumentStatus } from '../../shared/ai-types'
import type { AiProcessingCoverage } from '../../shared/ai-processing-coverage'
import { cleanupTempDir, extractArchive, getAllFilesInDir, isSupportedArchive, listArchiveFiles } from '../archive'
import { extractTextFromVisualFile, getAiProviderConfig, transcribeMediaFile } from './ai-provider'
import { convertLegacyOfficeLocally, extractEmbeddedSubtitle, ocrImageLocally, ocrPdfLocally, transcribeMediaLocally, withRenderedPdfPage } from './local-ai-tools'
import { getAiProcessingPolicy } from './processing-policy'
import { extractDocxText, formatXlsxNumber, serializeTableCell } from './office-text'
import { extractPdfPageText, pdfTextWarnings } from './pdf-text-layout'

const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024
const MAX_XML_ENTRY_SIZE = 20 * 1024 * 1024
const MAX_TOTAL_XML_SIZE = 60 * 1024 * 1024
const MAX_PDF_SIZE = 200 * 1024 * 1024
const MAX_PDF_PAGES = 1_000
const PDF_PARSE_TIMEOUT_MS = 90_000
const MAX_PDF_OCR_PAGES = 50
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
  partial?: boolean
  coverage?: AiProcessingCoverage
}

export interface AiParsedSection {
  content: string
  pageNumber?: number
  section?: string
  startSeconds?: number
  endSeconds?: number
}

type ZipEntry = {
  path: string
  type: string
  size?: number
  uncompressedSize?: number
  buffer: () => Promise<Buffer>
}

export function decodeXmlText(value: string): string {
  const codePoint = (match: string, code: string, radix: number) => {
    const point = Number.parseInt(code, radix)
    return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : match
  }
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => codePoint(match, code, 16))
    .replace(/&#([0-9]+);/g, (match, code) => codePoint(match, code, 10))
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
    if (text) values.push(text)
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
    const truncated = fs.fstatSync(fd).size > bytes
    const input = buffer.subarray(0, bytes)
    let encoding = 'utf-8'
    if (input[0] === 0xff && input[1] === 0xfe) encoding = 'utf-16le'
    else if (input[0] === 0xfe && input[1] === 0xff) encoding = 'utf-16be'
    let content: string
    try { content = new TextDecoder(encoding, { fatal: true }).decode(input, { stream: truncated }) }
    catch {
      if (encoding !== 'utf-8') throw new Error('文本编码损坏，请另存为 UTF-8 后重试')
      try { content = new TextDecoder('gb18030', { fatal: true }).decode(input, { stream: truncated }) }
      catch { throw new Error('无法识别文本编码，请另存为 UTF-8 后重试') }
    }
    if (content.includes('\0')) throw new Error('文件包含二进制内容或无 BOM 的 UTF-16，请另存为 UTF-8 后重试')
    return truncated ? `${content}\n\n[文件过大，仅提取前 2 MB，后续内容未索引]` : content
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
  const declaredSize = Number(entry.uncompressedSize ?? entry.size ?? 0)
  if (declaredSize > MAX_XML_ENTRY_SIZE) throw new Error(`Office XML 条目过大: ${entry.path}`)
  budget.total += declaredSize
  if (budget.total > MAX_TOTAL_XML_SIZE) throw new Error('Office 文档展开后的 XML 总量超过安全限制')
  const buffer = await entry.buffer()
  if (buffer.length > MAX_XML_ENTRY_SIZE) throw new Error(`Office XML 条目过大: ${entry.path}`)
  budget.total += Math.max(0, buffer.length - declaredSize)
  if (budget.total > MAX_TOTAL_XML_SIZE) throw new Error('Office 文档展开后的 XML 总量超过安全限制')
  return buffer.toString('utf8')
}

function numericSuffix(entryPath: string): number {
  return Number(entryPath.match(/(\d+)\.xml$/)?.[1] || Number.MAX_SAFE_INTEGER)
}

function xmlAttributes(value: string): Record<string, string> {
  return Object.fromEntries([...value.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)]
    .map(match => [match[1], decodeXmlText(match[3])]))
}

async function officeRelationships(entries: ZipEntry[], owner: string, budget: { total: number }): Promise<Map<string, string>> {
  const directory = path.posix.dirname(owner)
  const entry = entries.find(item => item.path === `${directory}/_rels/${path.posix.basename(owner)}.rels`)
  const relationships = new Map<string, string>()
  if (!entry) return relationships
  const xml = await readXmlEntry(entry, budget)
  for (const match of xml.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/g)) {
    const attrs = xmlAttributes(match[1])
    if (!attrs.Id || !attrs.Target || attrs.TargetMode === 'External') continue
    const target = attrs.Target.startsWith('/') ? attrs.Target.slice(1) : path.posix.join(directory, attrs.Target)
    relationships.set(attrs.Id, path.posix.normalize(target))
  }
  return relationships
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
    const content = extractDocxText(xml, decodeXmlText)
    if (content.trim()) sections.push({
      section: entry.path === 'word/document.xml' ? '正文' : entry.path.replace(/^word\//, '').replace(/\.xml$/i, ''),
      content,
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
    for (const match of xml.matchAll(/<(?:x:)?si(?:\s[^>]*)?>([\s\S]*?)<\/(?:x:)?si>/gi)) {
      sharedStrings.push(extractXmlTagText(match[1].replace(/<(?:x:)?rPh\b[^>]*>[\s\S]*?<\/(?:x:)?rPh>/gi, ''), '(?:x:)?t').join(''))
    }
  }

  const workbookEntry = entries.find(entry => entry.path === 'xl/workbook.xml')
  const sheetMetadata: Array<{ name: string; target?: string }> = []
  let date1904 = false
  if (workbookEntry) {
    const workbookXml = await readXmlEntry(workbookEntry, budget)
    const workbookProperties = workbookXml.match(/<(?:x:)?workbookPr\b([^>]*)>/i)
    date1904 = ['1', 'true'].includes(xmlAttributes(workbookProperties?.[1] || '').date1904)
    const relationships = await officeRelationships(entries, 'xl/workbook.xml', budget)
    for (const match of workbookXml.matchAll(/<(?:x:)?sheet\b([^>]*)>/gi)) {
      const attrs = xmlAttributes(match[1])
      sheetMetadata.push({ name: attrs.name, target: relationships.get(attrs['r:id']) })
    }
  }

  const numberFormats: number[] = []
  const stylesEntry = entries.find(entry => entry.path === 'xl/styles.xml')
  if (stylesEntry) {
    const stylesXml = await readXmlEntry(stylesEntry, budget)
    const customFormats = new Set([...stylesXml.matchAll(/<(?:x:)?numFmt\b([^>]*)>/gi)].map(match => Number(xmlAttributes(match[1]).numFmtId)))
    const baseFormatsXml = stylesXml.match(/<(?:x:)?cellStyleXfs\b[^>]*>([\s\S]*?)<\/(?:x:)?cellStyleXfs>/i)?.[1] || ''
    const baseFormats = [...baseFormatsXml.matchAll(/<(?:x:)?xf\b([^>]*)>/gi)].map(match => Number(xmlAttributes(match[1]).numFmtId || 0))
    const cellFormatsXml = stylesXml.match(/<(?:x:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:x:)?cellXfs>/i)?.[1] || ''
    for (const match of cellFormatsXml.matchAll(/<(?:x:)?xf\b([^>]*)>/gi)) {
      const attributes = xmlAttributes(match[1])
      const baseFormat = baseFormats[Number(attributes.xfId || 0)] || 0
      const format = ['0', 'false'].includes(attributes.applyNumberFormat) ? baseFormat : Number(attributes.numFmtId ?? baseFormat)
      numberFormats.push(customFormats.has(format) ? 0 : format)
    }
  }

  const fallbackSheets = entries
    .filter(entry => entry.type !== 'Directory' && /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.path))
    .sort((left, right) => numericSuffix(left.path) - numericSuffix(right.path))
  const sheets = sheetMetadata.length ? sheetMetadata.map((sheet, index) => {
    const entry = sheet.target ? entries.find(item => item.path === sheet.target) : fallbackSheets[index]
    if (!entry) throw new Error(`XLSX 工作表关系无效：${sheet.name}`)
    return entry
  }) : fallbackSheets
  if (!sheets.length) throw new Error('XLSX 中没有找到工作表')
  const sections: AiParsedSection[] = []
  for (let index = 0; index < sheets.length; index++) {
    const xml = await readXmlEntry(sheets[index], budget)
    const rows: string[] = []
    for (const rowMatch of xml.matchAll(/<(?:x:)?row(?:\s[^>]*)?>([\s\S]*?)<\/(?:x:)?row>/gi)) {
      const cells: string[] = []
      for (const cellMatch of rowMatch[1].matchAll(/<(?:x:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:x:)?c>)/gi)) {
        const attributes = xmlAttributes(cellMatch[1])
        const body = cellMatch[2] || ''
        const type = attributes.t || ''
        const cached = body.match(/<(?:x:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:x:)?v>/i)?.[1]
        let value = decodeXmlText(cached || '')
        if (type === 's' && cached !== undefined) {
          const stringIndex = Number(value)
          if (!Number.isInteger(stringIndex) || stringIndex < 0 || stringIndex >= sharedStrings.length) throw new Error('XLSX 共享字符串索引无效')
          value = sharedStrings[stringIndex]
        }
        else if (type === 'inlineStr') value = extractXmlTagText(body, '(?:x:)?t').join('')
        else if (type === 'b') value = value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value
        else if ((!type || type === 'n') && cached !== undefined) {
          value = formatXlsxNumber(value, numberFormats[Number(attributes.s || 0)] || 0, date1904)
        }
        const formula = body.match(/<(?:x:)?f(?:\s[^>]*)?>([\s\S]*?)<\/(?:x:)?f>/i)?.[1]
        if (formula && cached === undefined) value = `=${decodeXmlText(formula)} [公式未计算]`
        const column = attributes.r?.match(/^([A-Z]+)\d+$/i)?.[1].toUpperCase()
        const columnIndex = column ? [...column].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0) - 1 : cells.length
        if (columnIndex >= 16_384) throw new Error('XLSX 单元格列号超出范围')
        while (cells.length < columnIndex) cells.push('')
        cells[columnIndex] = serializeTableCell(value)
      }
      if (cells.some(Boolean)) rows.push(cells.join('\t'))
    }
    const sheetName = sheetMetadata[index]?.name || `Sheet ${index + 1}`
    sections.push({ section: `工作表：${sheetName}`, content: rows.join('\n') })
  }
  return sections
}

async function parsePptx(filePath: string): Promise<AiParsedSection[]> {
  const entries = await openOfficeEntries(filePath)
  const budget = { total: 0 }
  const fallbackSlides = entries
    .filter(entry => entry.type !== 'Directory' && /^ppt\/slides\/slide\d+\.xml$/i.test(entry.path))
    .sort((left, right) => numericSuffix(left.path) - numericSuffix(right.path))
  let slides = fallbackSlides
  const presentation = entries.find(entry => entry.path === 'ppt/presentation.xml')
  if (presentation) {
    const xml = await readXmlEntry(presentation, budget)
    const relationships = await officeRelationships(entries, presentation.path, budget)
    const slideIds = [...xml.matchAll(/<p:sldId\b([^>]*)>/gi)]
    if (slideIds.length) slides = slideIds.map(match => {
      const target = relationships.get(xmlAttributes(match[1])['r:id'])
      const entry = entries.find(item => item.path === target)
      if (!entry) throw new Error('PPTX 幻灯片关系无效')
      return entry
    })
  }
  if (!slides.length) throw new Error('PPTX 中没有找到幻灯片')
  const notes = new Map<number, ZipEntry>()
  for (const entry of entries) {
    if (/^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry.path)) notes.set(numericSuffix(entry.path), entry)
  }
  const sections: AiParsedSection[] = []
  for (let index = 0; index < slides.length; index++) {
    const number = numericSuffix(slides[index].path)
    const slideXml = await readXmlEntry(slides[index], budget)
    const paragraphs = [...slideXml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi)]
    const lines = paragraphs.length ? paragraphs.map(match => extractXmlTagText(match[1].replace(/<a:br\b[^>]*\/>/gi, '<a:t>\n</a:t>'), 'a:t').join('')) : extractXmlTagText(slideXml, 'a:t')
    let content = lines.join('\n')
    const slideRelationships = await officeRelationships(entries, slides[index].path, budget)
    const noteTarget = [...slideRelationships.values()].find(target => /^ppt\/notesSlides\//.test(target))
    const noteEntry = noteTarget ? entries.find(entry => entry.path === noteTarget) : slideRelationships.size ? undefined : notes.get(number)
    if (noteEntry) {
      const noteXml = await readXmlEntry(noteEntry, budget)
      const noteLines = extractXmlTagText(noteXml.replace(/<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/gi, shape => /<p:ph\b[^>]*\btype=["'](?:sldNum|hdr|ftr|dt)["']/.test(shape) ? '' : shape), 'a:t')
      if (noteLines.length) content += `\n\n备注：\n${noteLines.join('\n')}`
    }
    sections.push({ section: `幻灯片 ${index + 1}`, pageNumber: index + 1, content })
  }
  return sections
}

async function parsePdf(filePath: string, signal?: AbortSignal): Promise<Array<AiParsedSection & { warnings?: string[] }>> {
  const stat = fs.statSync(filePath)
  if (stat.size > MAX_PDF_SIZE) throw new Error('PDF 超过 200 MB 安全解析限制')
  const parser = new PDFParser(null, true)
  try {
    const output = await new Promise<PdfOutput>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        callback()
      }
      const abort = () => finish(() => reject(new Error('文件解析已取消')))
      const timer = setTimeout(() => finish(() => reject(new Error('PDF 解析超时'))), PDF_PARSE_TIMEOUT_MS)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) { abort(); return }
      parser.on('pdfParser_dataReady', data => finish(() => resolve(data)))
      parser.on('pdfParser_dataError', error => finish(() => {
        const cause = 'parserError' in error ? error.parserError : error
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }))
      parser.loadPDF(filePath, 0).catch(error => finish(() => reject(error)))
    })
    if (output.Pages.length > MAX_PDF_PAGES) throw new Error(`PDF 页数超过 ${MAX_PDF_PAGES} 页安全限制`)
    return output.Pages.map((page, index) => ({
      pageNumber: index + 1,
      section: `第 ${index + 1} 页`,
      content: extractPdfPageText(page.Texts || []),
      warnings: pdfTextWarnings(page.Texts || []),
    }))
  } finally {
    parser.destroy()
  }
}

function previewFromSections(sections: AiParsedSection[]): string {
  return clipPreview(sections.map(section => {
    const label = section.section || (section.pageNumber ? `第 ${section.pageNumber} 页` : '')
    return `${label ? `# ${label}\n` : ''}${section.content}`
  }).join('\n\n'))
}

function parseSubtitle(filePath: string, extension: string): AiParsedSection[] {
  return parseSubtitleContent(readTextPreview(filePath), extension)
}

async function parsePdfDocument(filePath: string, signal?: AbortSignal): Promise<AiParseResult> {
  const pages = await parsePdf(filePath, signal)
  const checkCancelled = () => { if (signal?.aborted) throw new Error('文件解析已取消') }
  const nativePageCount = pages.filter(page => page.content.trim()).length
  const missingPages = () => pages.filter(page => !page.content.trim()).map(page => page.pageNumber!)
  let localPageCount = 0
  let modelPageCount = 0
  const diagnostics: string[] = pages.flatMap(page => (page.warnings || []).map(warning => `第 ${page.pageNumber} 页：${warning}`))
  let qualityWarnings = diagnostics.length > 0
  const needed = missingPages()
  if (needed.length) {
    const selected = needed.slice(0, MAX_PDF_OCR_PAGES)
    if (needed.length > selected.length) diagnostics.push(`本次最多对 ${MAX_PDF_OCR_PAGES} 个缺失文本页补充识别`)
    try {
      const recognized = await ocrPdfLocally(filePath, signal, selected)
      checkCancelled()
      for (const page of recognized || []) {
        if (!selected.includes(page.pageNumber)) continue
        if (page.warnings?.length) {
          qualityWarnings = true
          diagnostics.push(...page.warnings.map(warning => `第 ${page.pageNumber} 页：${warning}`))
        }
        if (!page.content.trim()) continue
        const target = pages[page.pageNumber - 1]
        if (!target || target.content.trim()) continue
        target.content = page.content
        target.section = `第 ${page.pageNumber} 页 · 本地 Tesseract OCR`
        localPageCount++
      }
      if (recognized === null) diagnostics.push('本地 PDF OCR 需要 Poppler 和 Tesseract 及对应语言包')
    } catch (error) {
      checkCancelled()
      diagnostics.push(`本地 PDF OCR 未完成：${error instanceof Error ? error.message : String(error)}`)
    }
    const remaining = selected.filter(pageNumber => !pages[pageNumber - 1].content.trim())
    if (remaining.length && getAiProcessingPolicy().allowModelFallback) {
      const config = getAiProviderConfig()
      if (config.model && config.baseUrl) {
        for (const pageNumber of remaining) {
          checkCancelled()
          // Only missing pages reach the configured model; never re-submit known text pages.
          if (!getAiProcessingPolicy().allowModelFallback) break
          try {
            let content = await withRenderedPdfPage(filePath, pageNumber, async (imagePath, pageSignal) => {
              checkCancelled()
              if (!getAiProcessingPolicy().allowModelFallback) return ''
              return extractTextFromVisualFile(imagePath, 'image/png', pageSignal)
            }, signal)
            checkCancelled()
            if (content === null && nativePageCount === 0 && localPageCount === 0 && modelPageCount === 0 && pages.length <= MAX_PDF_OCR_PAGES && config.type !== 'ollama' && getAiProcessingPolicy().allowModelFallback) {
              content = await extractTextFromVisualFile(filePath, 'application/pdf', signal)
              checkCancelled()
              if (content.trim() && pages.length > 1) {
                const sections = [{ section: '扫描 PDF 整文件模型 OCR（页码未确认）', content }]
                return { status: 'ready', sections, preview: previewFromSections(sections), partial: true, message: `已使用模型提取纯扫描 PDF（${pages.length} 页）；缺少逐页渲染工具，无法确认结果的逐页对应及完整性，请核对原文` }
              }
            }
            if (content === null) {
              diagnostics.push(`逐页模型补充识别需要 Poppler；不会把已有解析内容的 PDF 整份发送给模型${config.type === 'ollama' ? '；Ollama 不支持直接输入 PDF' : ''}`)
              break
            }
            if (content.trim()) {
              pages[pageNumber - 1].content = content
              pages[pageNumber - 1].section = `第 ${pageNumber} 页 · 视觉模型 OCR`
              modelPageCount++
            }
          } catch (error) {
            checkCancelled()
            diagnostics.push(`模型补充识别未完成：${error instanceof Error ? error.message : String(error)}`)
            break
          }
        }
      } else diagnostics.push('尚未配置可用视觉模型')
    } else if (remaining.length) diagnostics.push('模型补充识别默认关闭，可安装本地 OCR 工具后重新解析')
  }
  const sections = pages.filter(page => page.content.trim())
  const missing = missingPages()
  const counts = `PDF 文本层提取 ${nativePageCount} 页${localPageCount ? `，本地 OCR 补充 ${localPageCount} 页` : ''}${modelPageCount ? `，模型补充 ${modelPageCount} 页` : ''}`
  const details = diagnostics.slice(0, 8).join('；') + (diagnostics.length > 8 ? `；另有 ${diagnostics.length - 8} 条页面提示` : '')
  const message = `${counts}${missing.length ? `；${missing.length} 页为空白或尚未识别` : ''}${details ? `；${details}` : ''}`
  return sections.length
    ? { status: 'ready', sections, preview: previewFromSections(sections), partial: missing.length > 0 || qualityWarnings, message,
      coverage: { version: 1, unit: 'pages', sourceUnits: pages.length, parsedUnits: sections.length, missingUnits: missing,
        sourceComplete: !missing.length, partial: missing.length > 0 || qualityWarnings, warnings: diagnostics } }
    : { status: 'awaiting_parser', partial: true, message,
      coverage: { version: 1, unit: 'pages', sourceUnits: pages.length, parsedUnits: 0, missingUnits: missing, sourceComplete: false, partial: true, warnings: diagnostics } }
}

export function subtitleTimeSeconds(value: string): number | undefined {
  const match = value.trim().match(/^(?:(\d{1,5}):)?(\d{1,3}):(\d{2})(?:[.,:](\d{1,3}))?$/)
  if (!match || Number(match[3]) > 59 || (match[1] !== undefined && Number(match[2]) > 59)) return undefined
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || 0}`)
}

function subtitleRange(start: string, end: string): Pick<AiParsedSection, 'startSeconds' | 'endSeconds'> {
  const startSeconds = subtitleTimeSeconds(start)
  const endSeconds = subtitleTimeSeconds(end)
  return startSeconds !== undefined && endSeconds !== undefined && endSeconds >= startSeconds ? { startSeconds, endSeconds } : {}
}

export function parseSubtitleContent(content: string, extension: string): AiParsedSection[] {
  if (extension === 'lrc') {
    return content.split(/\r?\n/).flatMap((line, index): AiParsedSection[] => {
      const match = line.match(/^((?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+)(.*)$/)
      return match ? [...match[1].matchAll(/\[([^\]]+)\]/g)].map(time => ({ section: `[${time[1]}]`, content: match[2].trim(), startSeconds: subtitleTimeSeconds(time[1]) })) : [{ section: `第 ${index + 1} 行`, content: line.trim() }]
    }).filter(item => item.content)
  }
  if (extension === 'ass' || extension === 'ssa') {
    let inEvents = false
    let format = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
    const sections: AiParsedSection[] = []
    for (const line of content.split(/\r?\n/)) {
      if (/^\[/.test(line)) inEvents = /^\[Events\]/i.test(line)
      if (inEvents && /^Format:/i.test(line)) format = line.replace(/^Format:\s*/i, '').toLowerCase().split(',').map(field => field.trim())
      if (!/^Dialogue:/i.test(line)) continue
      const fields = line.replace(/^Dialogue:\s*/i, '').split(',')
      const textIndex = format.indexOf('text')
      if (textIndex < 0) continue
      const value = fields.slice(textIndex).join(',').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').replace(/\{[^}]*\}/g, '').trim()
      if (value) {
        const start = fields[format.indexOf('start')] || '', end = fields[format.indexOf('end')] || ''
        sections.push({ section: `${start} → ${end}`, content: value, ...subtitleRange(start, end) })
      }
    }
    return sections
  }
  const normalized = content.replace(/^WEBVTT[^\n]*\n/i, '')
  return normalized.split(/\r?\n\s*\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    if (/^(?:NOTE(?:\s|$)|STYLE$|REGION$)/.test(lines[0] || '')) return []
    const timingIndex = lines.findIndex(line => line.includes('-->'))
    if (timingIndex < 0 || timingIndex > 1) return []
    const timing = lines[timingIndex].match(/^((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})(?:\s|$)/)
    if (!timing) return []
    const text = decodeXmlText(lines.slice(timingIndex + 1).join('\n').replace(/<[^>]+>/g, '')).replace(/&nbsp;/g, ' ').trim()
    return text ? [{ section: `${timing[1]} → ${timing[2]}`, content: text, ...subtitleRange(timing[1], timing[2]) }] : []
  })
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

function mimeForExtension(extension: string): string {
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', aac: 'audio/aac', ogg: 'audio/ogg', m4a: 'audio/mp4',
    mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime', webm: 'video/webm',
    pdf: 'application/pdf',
  }
  return types[extension] || 'application/octet-stream'
}

async function parseArchiveDocument(filePath: string, depth: number, signal?: AbortSignal): Promise<{ sections: AiParsedSection[]; skipped: number }> {
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
    let skipped = files.length - extracted.length
    for (const file of extracted) {
      if (signal?.aborted) throw new Error('文件解析已取消')
      if (sections.length >= 2_000) { skipped++; continue }
      const extension = path.extname(file.relativePath).slice(1).toLowerCase()
      if (!extension || file.size > AI_ARCHIVE_MAX_FILE_SIZE) { skipped++; continue }
      const result = await parseAiDocument(file.fullPath, extension, { archiveDepth: depth + 1, signal })
      if (result.status !== 'ready' || !result.sections?.length) { skipped++; continue }
      const remaining = 2_000 - sections.length
      if (result.partial || result.sections.length > remaining) skipped++
      for (const section of result.sections.slice(0, remaining)) sections.push({
        pageNumber: section.pageNumber,
        section: `${file.relativePath}${section.section ? ` · ${section.section}` : ''}`,
        content: section.content,
      })
    }
    if (!sections.length) throw new Error('压缩包中没有提取到可索引文字')
    return { sections, skipped }
  } finally {
    cleanupTempDir(outputDir)
  }
}

export async function parseAiDocument(filePath: string, extension: string, options: { archiveDepth?: number; signal?: AbortSignal } = {}): Promise<AiParseResult> {
  const result = await parseAiDocumentUntracked(filePath, extension, options)
  if (!result.coverage) {
    const directText = TEXT_EXTENSIONS.has(extension.replace(/^\./, '').toLowerCase()) || SUBTITLE_EXTENSIONS.has(extension.replace(/^\./, '').toLowerCase())
    let sourceBytes: number | undefined
    try { sourceBytes = fs.statSync(filePath).size } catch { /* failed parsing retains unknown source coverage */ }
    result.coverage = { version: 1, unit: directText ? 'bytes' : 'sections', sourceUnits: directText ? sourceBytes : undefined,
      parsedUnits: result.status === 'ready' ? directText ? Math.min(sourceBytes ?? 0, TEXT_PREVIEW_LIMIT) : result.sections?.length ?? 0 : 0,
      sourceComplete: directText && result.status === 'ready' && !result.partial,
      partial: Boolean(result.partial || result.status !== 'ready'), warnings: result.partial || !directText ? [result.message] : [] }
  }
  return result
}

async function parseAiDocumentUntracked(filePath: string, extension: string, options: { archiveDepth?: number; signal?: AbortSignal }): Promise<AiParseResult> {
  try {
    extension = extension.replace(/^\./, '').toLowerCase()
    const checkCancelled = () => { if (options.signal?.aborted) throw new Error('文件解析已取消') }
    checkCancelled()
    if (TEXT_EXTENSIONS.has(extension)) {
      const content = readTextPreview(filePath)
      if (!content.trim()) return { status: 'failed', message: '文件中没有提取到可用文本' }
      const partial = fs.statSync(filePath).size > TEXT_PREVIEW_LIMIT
      return { status: 'ready', preview: content, sections: [{ section: '正文', content }], partial, message: partial ? '仅提取前 2 MB 文本，后续内容未索引' : '文本内容已提取' }
    }
    let sections: AiParsedSection[] = []
    let parseMessage = '文件内容已提取'
    let partial = false
    if (extension === 'pdf') return await parsePdfDocument(filePath, options.signal)
    else if (extension === 'docx') {
      sections = await parseDocx(filePath)
      parseMessage = 'Word 当前正文和表格已提取，不含删除或移出修订；表格单元格内换行和制表符以 JSON 引号转义保留'
    }
    else if (extension === 'xlsx') sections = await parseXlsx(filePath)
    else if (extension === 'pptx') sections = await parsePptx(filePath)
    else if (SUBTITLE_EXTENSIONS.has(extension)) {
      sections = parseSubtitle(filePath, extension)
      partial = fs.statSync(filePath).size > TEXT_PREVIEW_LIMIT
      if (partial) parseMessage = '字幕仅提取前 2 MB，后续内容未索引'
    }
    else if (LEGACY_OFFICE_EXTENSIONS.has(extension)) {
      if (fs.statSync(filePath).size > 100 * 1024 * 1024) throw new Error('旧版 Office 文件超过 100 MB 解析限制')
      const converted = await convertLegacyOfficeLocally(filePath, extension, options.signal)
      if (converted) {
        try {
          const convertedExtension = path.extname(converted.filePath).slice(1).toLowerCase()
          const result = await parseAiDocument(converted.filePath, convertedExtension, options)
          if (result.status === 'ready' && result.sections) {
            sections = result.sections.map(section => ({ ...section, section: `LibreOffice 转换 · ${section.section || ''}` }))
            parseMessage = result.message
            partial = result.partial || false
          }
          else throw new Error(result.message)
        } finally { converted.cleanup() }
      } else return { status: 'awaiting_parser', message: '旧版 Office 需要安装 LibreOffice 进行格式转换，或另存为 DOCX/XLSX/PPTX 后导入' }
    }
    else if (IMAGE_EXTENSIONS.has(extension)) {
      let content: string | null = null
      try { content = await ocrImageLocally(filePath, options.signal) } catch { /* fall back to configured model */ }
      checkCancelled()
      if (content) sections = [{ section: '本地 Tesseract OCR', content }]
      else {
        if (!getAiProcessingPolicy().allowModelFallback) return { status: 'awaiting_parser', message: '图片未提取到本地 OCR 文字；模型补充识别默认关闭，请安装 Tesseract 及对应语言包后重新解析' }
        if (!getAiProviderConfig().model) return { status: 'awaiting_parser', message: '图片已导入；安装 Tesseract 或配置视觉模型后重新解析即可 OCR' }
        content = await extractTextFromVisualFile(filePath, mimeForExtension(extension), options.signal)
        sections = [{ section: '视觉模型 OCR', content }]
      }
    }
    else if (MEDIA_EXTENSIONS.has(extension)) {
      const sidecar = findSidecarSubtitle(filePath)
      if (sidecar) {
        try {
          sections = parseSubtitle(sidecar.filePath, sidecar.extension).map(section => ({ ...section, section: `外挂字幕 · ${section.section || ''}` }))
          partial = sections.length > 0 && fs.statSync(sidecar.filePath).size > TEXT_PREVIEW_LIMIT
          if (partial) parseMessage = '外挂字幕仅提取前 2 MB，后续内容未索引'
        }
        catch { /* invalid subtitle files do not prevent other transcription methods */ }
      }
      if (!sections.some(section => section.content.trim())) {
        let embeddedSubtitle: string | null = null
        try { embeddedSubtitle = await extractEmbeddedSubtitle(filePath, options.signal) } catch { /* image subtitles may not be text-extractable */ }
        checkCancelled()
        if (embeddedSubtitle) sections = parseSubtitleContent(embeddedSubtitle, 'vtt').map(section => ({ ...section, section: `FFmpeg 内嵌字幕 · ${section.section || ''}` }))
        if (!sections.some(section => section.content.trim())) {
          let localTranscript: string | null = null
          try { localTranscript = await transcribeMediaLocally(filePath, options.signal) } catch { /* fall back to remote transcription */ }
          checkCancelled()
          if (localTranscript) {
            const timed = parseSubtitleContent(localTranscript, 'srt').filter(section => section.startSeconds !== undefined)
            sections = timed.length ? timed.map(section => ({ ...section, section: `本地 Whisper 转写 · ${section.section || ''}` }))
              : [{ section: '本地 Whisper 转写', content: localTranscript }]
          }
          else {
            if (!getAiProcessingPolicy().allowModelFallback) return { status: 'awaiting_parser', message: '未发现可用字幕或本地转写结果；模型补充识别默认关闭，请安装 FFmpeg + Whisper 及本地模型后重新解析' }
            const config = getAiProviderConfig()
            if (!config.baseUrl || !config.transcriptionModel || !['openai-compatible', 'openai-responses'].includes(config.type)) return { status: 'awaiting_parser', message: '未发现可用字幕；安装 FFmpeg + Whisper，或配置支持 /audio/transcriptions 的 OpenAI 兼容接口和转写模型后重试' }
            const content = await transcribeMediaFile(filePath, mimeForExtension(extension), options.signal)
            sections = [{ section: '云端语音转写', content }]
          }
        }
      }
    }
    else if (ARCHIVE_EXTENSIONS.has(extension) && isSupportedArchive(filePath)) {
      const archive = await parseArchiveDocument(filePath, options.archiveDepth || 0, options.signal)
      sections = archive.sections
      partial = archive.skipped > 0
      parseMessage = archive.skipped ? `压缩包部分内容已提取，${archive.skipped} 个文件因格式、依赖或安全限制未完整解析` : '压缩包可支持文件的文本已提取'
    }
    else if (ADVANCED_EXTENSIONS.has(extension)) return { status: 'awaiting_parser', message: '文件已导入，等待对应解析能力' }
    else return { status: 'unsupported', message: '暂不支持该文件类型' }

    checkCancelled()
    if (!sections.some(section => section.content.trim())) {
      return { status: 'failed', message: '文件中没有提取到可用文本' }
    }
    return {
      status: 'ready',
      preview: previewFromSections(sections),
      sections,
      partial,
      message: extension === 'xlsx' ? '工作表内容已提取；常见内置日期归一化为 YYYY-MM-DD，内置百分比保留单位，其他格式保留原始值；公式使用文件缓存值，未重新计算；单元格内换行和制表符以 JSON 引号转义保留' : parseMessage,
    }
  } catch (error) {
    return { status: 'failed', message: error instanceof Error ? error.message : String(error) }
  }
}
