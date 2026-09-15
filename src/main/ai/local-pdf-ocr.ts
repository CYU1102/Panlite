import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { detectTesseractReadingOrderWarnings } from './ocr-layout-diagnostics'
import { getPdfOcrResolutionWarnings } from './pdf-ocr-resolution'

export const LOCAL_PDF_OCR_LIMITS = Object.freeze({
  maxFileBytes: 200 * 1024 * 1024,
  maxPages: 50,
  maxPageNumber: 1_000,
  maxDimension: 3_500,
  maxImageBytes: 64 * 1024 * 1024,
  maxTextBytes: 2 * 1024 * 1024,
  totalTimeoutMs: 10 * 60_000,
})

export interface PdfLocalCommandOptions { timeoutMs?: number; signal?: AbortSignal; maxStdoutBytes?: number }
export type PdfLocalCommand = (executable: string, args: string[], options?: PdfLocalCommandOptions) => Promise<{ stdout: string; stderr: string }>
export interface PdfLocalTools { pdftoppm: string; tesseract: string; language: string; run: PdfLocalCommand; deadlineAt?: number }
export interface PdfOcrPage {
  pageNumber: number
  content: string
  /** Mean Tesseract word confidence (0–100), not a measured recognition accuracy. */
  confidence?: number
  warnings?: string[]
}

class PdfOcrBudgetError extends Error {}

/** TSV contributes quality diagnostics only; plain text remains the original engine output. */
export function parseTesseractConfidence(tsv: string): Pick<PdfOcrPage, 'confidence' | 'warnings'> {
  const lines = tsv.replace(/^\uFEFF/, '').split(/\r?\n/)
  const header = (lines.shift() || '').split('\t')
  const levelIndex = header.indexOf('level')
  const confidenceIndex = header.indexOf('conf')
  const textIndex = header.indexOf('text')
  if ([levelIndex, confidenceIndex, textIndex].some(index => index < 0)) return { warnings: ['未获得有效的 Tesseract 词级置信度，请核对原文'] }
  let total = 0
  let count = 0
  let lowCount = 0
  let invalid = false
  const examples: string[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const cells = line.split('\t')
    if (cells[levelIndex] !== '5') continue
    const text = cells.slice(textIndex).join('\t').trim()
    if (!text) continue
    const value = cells[confidenceIndex]?.trim()
    const confidence = value ? Number(value) : NaN
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) { invalid = true; continue }
    total += confidence
    count++
    if (confidence < 60) {
      lowCount++
      if (examples.length < 5) examples.push(text.replace(/[\r\n\t]/g, ' ').slice(0, 24))
    }
  }
  const warnings = detectTesseractReadingOrderWarnings(tsv)
  if (lowCount) warnings.push(`有 ${lowCount} 个词的 OCR 引擎置信度低于 60，需核对原文（例如：${examples.join('、')}）；分数不代表准确率`)
  if (invalid) warnings.push('部分 OCR 词级置信度记录无效，已保留原始识别正文')
  if (!count) warnings.push('未获得可用的 OCR 词级置信度，请核对原文')
  return { ...(count ? { confidence: Math.round(total / count * 10) / 10 } : {}), ...(warnings.length ? { warnings } : {}) }
}

function readOcrText(filePath: string, directory: string, maxBytes: number): string {
  const stat = fs.lstatSync(filePath)
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(filePath))
  if (!stat.isFile() || stat.isSymbolicLink() || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('OCR 文本输出路径无效')
  if (stat.size > maxBytes) throw new Error('单页 OCR 输出超过大小限制')
  return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filePath))
}

function validatePdf(filePath: string): string {
  const resolved = path.resolve(filePath)
  const stat = fs.statSync(resolved)
  if (!stat.isFile()) throw new Error('PDF 输入不是普通文件')
  if (stat.size > LOCAL_PDF_OCR_LIMITS.maxFileBytes) throw new Error('PDF 超过 200 MB 本地 OCR 限制')
  return resolved
}

function validatePages(pageNumbers?: number[]): number[] {
  if (!Array.isArray(pageNumbers)) throw new Error('本地 PDF OCR 需要提供待识别的页码')
  if (pageNumbers.some(page => !Number.isSafeInteger(page) || page < 1 || page > LOCAL_PDF_OCR_LIMITS.maxPageNumber)) throw new Error('PDF OCR 页码无效')
  const pages = [...new Set(pageNumbers)].sort((a, b) => a - b)
  if (pages.length > LOCAL_PDF_OCR_LIMITS.maxPages) throw new Error('一次最多对 50 页扫描 PDF 执行本地 OCR，请拆分文档')
  return pages
}

function validateRenderedImage(filePath: string, directory: string): { width: number; height: number } {
  const stat = fs.lstatSync(filePath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > LOCAL_PDF_OCR_LIMITS.maxImageBytes) throw new Error('PDF 渲染输出不合法或超过大小限制')
  const relative = path.relative(fs.realpathSync(directory), fs.realpathSync(filePath))
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('PDF 渲染输出路径越界')
  const header = Buffer.alloc(24)
  const fd = fs.openSync(filePath, 'r')
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || header.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PDF 未渲染出有效 PNG 图片')
  } finally { fs.closeSync(fd) }
  const width = header.readUInt32BE(16)
  const height = header.readUInt32BE(20)
  if (!width || !height || width > LOCAL_PDF_OCR_LIMITS.maxDimension || height > LOCAL_PDF_OCR_LIMITS.maxDimension) throw new Error('PDF 单页像素超过本地 OCR 限制')
  return { width, height }
}

async function renderPage(filePath: string, page: number, directory: string, tools: Pick<PdfLocalTools, 'pdftoppm' | 'run'>, signal: AbortSignal, timeoutMs: number): Promise<string> {
  signal.throwIfAborted()
  const prefix = path.join(directory, `page-${page}`)
  // -f/-l and -singlefile restrict each subprocess to exactly one requested page.
  // -scale-to bounds both dimensions even for unusually large PDF media boxes.
  await tools.run(tools.pdftoppm, ['-f', String(page), '-l', String(page), '-singlefile', '-scale-to', String(LOCAL_PDF_OCR_LIMITS.maxDimension), '-png', filePath, prefix], {
    signal, timeoutMs: Math.min(timeoutMs, 45_000), maxStdoutBytes: 256 * 1024,
  })
  signal.throwIfAborted()
  const imagePath = `${prefix}.png`
  validateRenderedImage(imagePath, directory)
  return imagePath
}

async function withPdfWorkspace<T>(filePath: string, signal: AbortSignal | undefined, work: (resolved: string, directory: string, signal: AbortSignal, remainingMs: () => number) => Promise<T>, timeoutMs = LOCAL_PDF_OCR_LIMITS.totalTimeoutMs): Promise<T> {
  signal?.throwIfAborted()
  const resolved = validatePdf(filePath)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-pdf-ocr-'))
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const deadline = Date.now() + timeoutMs
  const timer = setTimeout(() => controller.abort(new PdfOcrBudgetError('本地 PDF OCR 总处理时间超过 10 分钟')), timeoutMs)
  timer.unref?.()
  try {
    return await work(resolved, directory, controller.signal, () => {
      controller.signal.throwIfAborted()
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new PdfOcrBudgetError('本地 PDF OCR 总处理时间超过 10 分钟')
      return remaining
    })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

export async function recognizePdfPages(filePath: string, tools: PdfLocalTools, signal?: AbortSignal, pageNumbers?: number[]): Promise<PdfOcrPage[]> {
  const pages = validatePages(pageNumbers)
  if (!pages.length) return []
  signal?.throwIfAborted()
  const timeoutMs = tools.deadlineAt === undefined ? LOCAL_PDF_OCR_LIMITS.totalTimeoutMs : Math.max(1, Math.min(LOCAL_PDF_OCR_LIMITS.totalTimeoutMs, tools.deadlineAt - Date.now()))
  return withPdfWorkspace(filePath, signal, async (resolved, directory, activeSignal, remainingMs) => {
    const result: PdfOcrPage[] = []
    let totalBytes = 0
    for (const [index, pageNumber] of pages.entries()) {
      let imagePath = path.join(directory, `page-${pageNumber}.png`)
      const outputBase = path.join(directory, `ocr-${pageNumber}`)
      try {
        imagePath = await renderPage(resolved, pageNumber, directory, tools, activeSignal, remainingMs())
        const resolutionWarnings = getPdfOcrResolutionWarnings(validateRenderedImage(imagePath, directory))
        await tools.run(tools.tesseract, [imagePath, outputBase, '-l', tools.language, '--psm', '3', 'txt', 'tsv'], {
          signal: activeSignal, timeoutMs: Math.min(remainingMs(), 60_000), maxStdoutBytes: 1024 * 1024,
        })
        activeSignal.throwIfAborted()
        const content = readOcrText(`${outputBase}.txt`, directory, 1024 * 1024).trim()
        totalBytes += Buffer.byteLength(content, 'utf8')
        if (totalBytes > LOCAL_PDF_OCR_LIMITS.maxTextBytes) throw new PdfOcrBudgetError('本地 PDF OCR 文本超过 2 MB 限制')
        let quality: Pick<PdfOcrPage, 'confidence' | 'warnings'>
        try { quality = parseTesseractConfidence(readOcrText(`${outputBase}.tsv`, directory, 8 * 1024 * 1024)) }
        catch { quality = { warnings: ['未获得有效的 OCR 词级置信度，已保留原始识别正文，请核对原文'] } }
        if (resolutionWarnings.length) quality.warnings = [...resolutionWarnings, ...(quality.warnings || [])]
        if (!content) quality.warnings = [...(quality.warnings || []), '本页未识别出文本，不能据此认定原页为空白']
        if (content.includes('\0') || content.includes('\uFFFD')) quality.warnings = [...(quality.warnings || []), '识别文本含异常字符，请核对原文']
        result.push({ pageNumber, content, ...quality })
      } catch (error) {
        signal?.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        if (activeSignal.aborted || error instanceof PdfOcrBudgetError) {
          const reason = activeSignal.reason instanceof Error ? activeSignal.reason.message : message
          result.push(...pages.slice(index).map(page => ({ pageNumber: page, content: '', warnings: [`${reason}；此页尚未完成识别，已保留此前成功页`] })))
          break
        }
        result.push({ pageNumber, content: '', warnings: [`本页本地 OCR 失败：${message}`] })
      } finally {
        if (imagePath) fs.rmSync(imagePath, { force: true })
        for (const extension of ['txt', 'tsv']) fs.rmSync(`${outputBase}.${extension}`, { force: true })
      }
    }
    return result
  }, timeoutMs)
}

/** Single-page renderer for an explicitly enabled model fallback; no network operation lives here. */
export async function withLocalRenderedPdfPage<T>(filePath: string, pageNumber: number, tools: Pick<PdfLocalTools, 'pdftoppm' | 'run'>, callback: (imagePath: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  validatePages([pageNumber])
  return withPdfWorkspace(filePath, signal, async (resolved, directory, activeSignal, remainingMs) => {
    const imagePath = await renderPage(resolved, pageNumber, directory, tools, activeSignal, remainingMs())
    let abort!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(activeSignal.reason || new Error('PDF 单页处理已取消'))
      activeSignal.addEventListener('abort', abort, { once: true })
      if (activeSignal.aborted) abort()
    })
    try {
      return await Promise.race([Promise.resolve().then(() => callback(imagePath, activeSignal)), cancelled])
    } finally { activeSignal.removeEventListener('abort', abort) }
  })
}
