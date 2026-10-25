import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { getSetting, setSetting } from '../db'
import type { AiLocalToolKey, AiLocalToolStatus, AiLocalToolsConfig } from '../../shared/ai-types'
import { LOCAL_PDF_OCR_LIMITS, recognizePdfPages, withLocalRenderedPdfPage, type PdfOcrPage } from './local-pdf-ocr'

const SETTINGS_KEY = 'aiLocalToolsV1'
const COMMAND_TIMEOUT_MS = 180_000
const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 2 * 1024 * 1024

const defaults: AiLocalToolsConfig = {
  tesseractPath: '', ffmpegPath: '', whisperPath: '', libreOfficePath: '', pdftoppmPath: '',
  ocrLanguage: 'chi_sim+eng', whisperModel: 'small', whisperModelPath: '',
}

type CommandResult = { stdout: string; stderr: string }

/** Keep language order (it affects Tesseract recognition), and never silently rewrite a typo. */
export function parseOcrLanguageSelection(value: string): string[] {
  const input = value.trim()
  const languages = input.split('+').map(language => language.trim())
  if (input.length > 100 || languages.some(language => !/^(?:script\/)?[a-zA-Z0-9_]+$/.test(language))) throw new Error('OCR 语言配置无效，请使用 chi_sim+eng 或 script/Latin 等语言标识')
  if (languages.every(language => language === 'osd')) throw new Error('osd 仅用于方向检测，不能作为文字识别语言')
  return [...new Set(languages)]
}

function cleanPath(value: unknown): string {
  const raw = String(value || '').trim().replace(/^"|"$/g, '')
  if (!raw) return ''
  const resolved = path.resolve(raw)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`工具文件不存在：${resolved}`)
  return resolved
}

export function getAiLocalToolsConfig(): AiLocalToolsConfig {
  let row: ReturnType<typeof getSetting>
  try { row = getSetting(SETTINGS_KEY) } catch { return { ...defaults } }
  if (!row?.value) return { ...defaults }
  try {
    const value = JSON.parse(row.value) as Partial<AiLocalToolsConfig>
    return {
      tesseractPath: String(value.tesseractPath || ''), ffmpegPath: String(value.ffmpegPath || ''),
      whisperPath: String(value.whisperPath || ''), libreOfficePath: String(value.libreOfficePath || ''),
      pdftoppmPath: String(value.pdftoppmPath || ''),
      ocrLanguage: String(value.ocrLanguage || defaults.ocrLanguage).slice(0, 100),
      whisperModel: String(value.whisperModel || defaults.whisperModel).slice(0, 100),
      whisperModelPath: String(value.whisperModelPath || ''),
    }
  } catch {
    return { ...defaults }
  }
}

export function saveAiLocalToolsConfig(input: Partial<AiLocalToolsConfig>): AiLocalToolsConfig {
  const config: AiLocalToolsConfig = {
    tesseractPath: cleanPath(input.tesseractPath), ffmpegPath: cleanPath(input.ffmpegPath),
    whisperPath: cleanPath(input.whisperPath), libreOfficePath: cleanPath(input.libreOfficePath),
    pdftoppmPath: cleanPath(input.pdftoppmPath),
    ocrLanguage: parseOcrLanguageSelection(String(input.ocrLanguage || defaults.ocrLanguage)).join('+'),
    whisperModel: String(input.whisperModel || defaults.whisperModel).trim().replace(/[^a-zA-Z0-9_+.-]/g, '').slice(0, 100) || defaults.whisperModel,
    whisperModelPath: cleanPath(input.whisperModelPath),
  }
  setSetting(SETTINGS_KEY, JSON.stringify(config))
  return config
}

const commonPaths: Record<AiLocalToolKey, string[]> = {
  tesseract: ['C:\\Program Files\\Tesseract-OCR\\tesseract.exe'],
  ffmpeg: ['C:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe'],
  whisper: ['C:\\whisper\\whisper-cli.exe', 'C:\\whisper.cpp\\build\\bin\\Release\\whisper-cli.exe'],
  libreoffice: ['C:\\Program Files\\LibreOffice\\program\\soffice.exe'],
  pdftoppm: ['C:\\Program Files\\poppler\\Library\\bin\\pdftoppm.exe', 'C:\\poppler\\Library\\bin\\pdftoppm.exe', 'C:\\poppler\\bin\\pdftoppm.exe'],
}

const executableNames: Record<AiLocalToolKey, string[]> = {
  tesseract: ['tesseract.exe', 'tesseract'], ffmpeg: ['ffmpeg.exe', 'ffmpeg'],
  whisper: ['whisper-cli.exe', 'main.exe', 'whisper.exe', 'whisper'],
  libreoffice: ['soffice.exe', 'libreoffice.exe', 'soffice', 'libreoffice'],
  pdftoppm: ['pdftoppm.exe', 'pdftoppm'],
}

function pathExecutable(names: string[]): string {
  for (const directory of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name)
      try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* continue */ }
    }
  }
  return ''
}

function configuredPath(key: AiLocalToolKey, config: AiLocalToolsConfig): string {
  const map: Record<AiLocalToolKey, keyof AiLocalToolsConfig> = {
    tesseract: 'tesseractPath', ffmpeg: 'ffmpegPath', whisper: 'whisperPath', libreoffice: 'libreOfficePath',
    pdftoppm: 'pdftoppmPath',
  }
  return String(config[map[key]] || '')
}

export function resolveAiLocalTool(key: AiLocalToolKey, config = getAiLocalToolsConfig()): string {
  const configured = configuredPath(key, config)
  if (configured) {
    try { if (fs.statSync(configured).isFile()) return configured } catch { /* auto-detect below */ }
  }
  const common = commonPaths[key].find(candidate => {
    try { return fs.statSync(candidate).isFile() } catch { return false }
  })
  return common || pathExecutable(executableNames[key])
}

async function runCommand(executable: string, args: string[], options: { timeoutMs?: number; signal?: AbortSignal; maxStdoutBytes?: number } = {}): Promise<CommandResult> {
  options.signal?.throwIfAborted()
  if (!path.isAbsolute(executable) || !fs.existsSync(executable)) throw new Error('本地能力工具路径无效')
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    let settled = false
    let stoppingError: Error | undefined
    const finish = (callback: () => void) => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); callback() }
    // Wait for process close before callers delete its temporary output directory.
    const stop = (error: Error) => { if (stoppingError || settled) return; stoppingError = error; child.kill('SIGKILL') }
    const abort = () => stop(Object.assign(new Error('本地 AI 处理已取消'), { name: 'AbortError' }))
    const timer = setTimeout(() => stop(new Error('本地能力工具执行超时')), options.timeoutMs || COMMAND_TIMEOUT_MS)
    options.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', (chunk: Buffer) => {
      if (stoppingError || settled) return
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > (options.maxStdoutBytes || MAX_STDOUT_BYTES)) stop(new Error('本地能力工具输出过大'))
    })
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < MAX_STDERR_BYTES) stderr = Buffer.concat([stderr, chunk]).subarray(0, MAX_STDERR_BYTES) })
    child.once('error', error => finish(() => reject(error)))
    child.once('close', code => finish(() => stoppingError ? reject(stoppingError) : code === 0
      ? resolve({ stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') })
      : reject(new Error((stderr.toString('utf8') || `工具退出码 ${code}`).trim().slice(0, 500)))))
    if (options.signal?.aborted) abort()
  })
}

export async function listAiLocalToolStatuses(): Promise<AiLocalToolStatus[]> {
  const config = getAiLocalToolsConfig()
  const descriptions: Record<AiLocalToolKey, [string, string]> = {
    tesseract: ['Tesseract OCR', '图片离线文字识别'], ffmpeg: ['FFmpeg', '内嵌字幕与音轨提取'],
    whisper: ['Whisper', '音视频离线语音转写'], libreoffice: ['LibreOffice', '旧版 Office 高精度转换'],
    pdftoppm: ['Poppler PDF 渲染', '扫描 PDF 逐页本地渲染与 OCR'],
  }
  const statuses: AiLocalToolStatus[] = await Promise.all((Object.keys(descriptions) as AiLocalToolKey[]).map(async key => {
    const resolvedPath = resolveAiLocalTool(key, config)
    if (!resolvedPath) return { key, name: descriptions[key][0], available: false, message: descriptions[key][1] }
    try {
      const args = key === 'ffmpeg' ? ['-version'] : key === 'pdftoppm' ? ['-v'] : key === 'whisper' ? ['--help'] : ['--version']
      const result = await runCommand(resolvedPath, args, { timeoutMs: 10_000, maxStdoutBytes: 256 * 1024 })
      const version = `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find(Boolean)?.trim().slice(0, 160)
      const status: AiLocalToolStatus = { key, name: descriptions[key][0], available: true, ready: true, resolvedPath, version, message: descriptions[key][1] }
      if (key === 'tesseract') {
        try {
          const languages = await runCommand(resolvedPath, ['--list-langs'], { timeoutMs: 10_000, maxStdoutBytes: 256 * 1024 })
          const installed = new Set(`${languages.stdout}\n${languages.stderr}`.split(/\r?\n/).map(line => line.trim()).filter(Boolean))
          const missing = parseOcrLanguageSelection(config.ocrLanguage).filter(language => !installed.has(language))
          if (missing.length) { status.ready = false; status.message = `缺少所选 OCR 语言包：${missing.join('、')}` }
        } catch (error) { status.ready = false; status.message = error instanceof Error && /语言配置|方向检测/.test(error.message) ? error.message : 'Tesseract 已检测到，但无法验证所选语言包' }
      }
      if (key === 'ffmpeg') {
        const probe = ffprobePath(resolvedPath)
        status.subtitleAvailable = false
        if (probe) {
          try {
            await runCommand(probe, ['-version'], { timeoutMs: 10_000, maxStdoutBytes: 256 * 1024 })
            status.subtitleAvailable = true
          } catch { /* Audio extraction can still work without ffprobe. */ }
        }
        if (!status.subtitleAvailable) status.message = '音轨提取可用；内嵌字幕还需要可运行的 FFprobe'
      }
      if (key === 'whisper') {
        if (/whisper-cli|main/i.test(path.basename(resolvedPath))) {
          let modelExists = false
          try { modelExists = Boolean(config.whisperModelPath && fs.statSync(config.whisperModelPath).isFile() && fs.statSync(config.whisperModelPath).size > 0) } catch { /* Missing model is reported below. */ }
          if (!modelExists) { status.ready = false; status.message = 'whisper.cpp 需要配置有效的本地模型文件' }
        } else status.message = 'Python Whisper 已检测到；首次使用可能需要下载所选模型'
      }
      return status
    } catch (error) {
      return { key, name: descriptions[key][0], available: false, resolvedPath, message: error instanceof Error ? error.message : String(error) }
    }
  }))
  const whisper = statuses.find(status => status.key === 'whisper')
  const pdf = statuses.find(status => status.key === 'pdftoppm')
  if (pdf?.available && !statuses.some(status => status.key === 'tesseract' && status.ready)) {
    pdf.ready = false
    pdf.message = 'PDF 渲染可用；扫描 PDF 本地识别还需要 Tesseract 及所选语言包'
  }
  if (whisper?.available && !statuses.some(status => status.key === 'ffmpeg' && status.ready)) {
    whisper.ready = false
    whisper.message += '；还需要可运行的 FFmpeg 提取音轨'
  }
  return statuses
}

export async function ocrImageLocally(filePath: string, signal?: AbortSignal): Promise<string | null> {
  const config = getAiLocalToolsConfig()
  const executable = resolveAiLocalTool('tesseract', config)
  if (!executable) return null
  const language = parseOcrLanguageSelection(config.ocrLanguage).join('+')
  const result = await runCommand(executable, [filePath, 'stdout', '-l', language, '--psm', '3'], { signal })
  return result.stdout.trim() || null
}

export async function ocrPdfLocally(filePath: string, signal?: AbortSignal, pageNumbers?: number[]): Promise<PdfOcrPage[] | null> {
  signal?.throwIfAborted()
  if (pageNumbers?.length === 0) return []
  const config = getAiLocalToolsConfig()
  const pdftoppm = resolveAiLocalTool('pdftoppm', config)
  const tesseract = resolveAiLocalTool('tesseract', config)
  if (!pdftoppm || !tesseract) return null
  const selectedLanguages = parseOcrLanguageSelection(config.ocrLanguage)
  const deadlineAt = Date.now() + LOCAL_PDF_OCR_LIMITS.totalTimeoutMs
  const languages = await runCommand(tesseract, ['--list-langs'], { signal, timeoutMs: 10_000, maxStdoutBytes: 256 * 1024 })
  const installed = new Set(`${languages.stdout}\n${languages.stderr}`.split(/\r?\n/).map(line => line.trim()))
  const missing = selectedLanguages.filter(language => !installed.has(language))
  if (missing.length) throw new Error(`缺少所选 OCR 语言包：${missing.join('、')}`)
  return recognizePdfPages(filePath, { pdftoppm, tesseract, language: selectedLanguages.join('+'), run: runCommand, deadlineAt }, signal, pageNumbers)
}

export async function withRenderedPdfPage<T>(filePath: string, pageNumber: number, callback: (imagePath: string, signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T | null> {
  signal?.throwIfAborted()
  const pdftoppm = resolveAiLocalTool('pdftoppm')
  if (!pdftoppm) return null
  return withLocalRenderedPdfPage(filePath, pageNumber, { pdftoppm, run: runCommand }, callback, signal)
}

function ffprobePath(ffmpegPath: string): string {
  const sibling = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
  return fs.existsSync(sibling) ? sibling : pathExecutable(process.platform === 'win32' ? ['ffprobe.exe'] : ['ffprobe'])
}

export function hasSubtitleStream(probe: unknown): boolean {
  const streams = (probe as { streams?: Array<{ codec_type?: string }> } | null)?.streams
  return Array.isArray(streams) && streams.some(stream => stream.codec_type === 'subtitle')
}

export async function extractEmbeddedSubtitle(filePath: string, signal?: AbortSignal): Promise<string | null> {
  const ffmpeg = resolveAiLocalTool('ffmpeg')
  if (!ffmpeg) return null
  const ffprobe = ffprobePath(ffmpeg)
  if (!ffprobe) return null
  const probeResult = await runCommand(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', filePath], { signal, timeoutMs: 30_000, maxStdoutBytes: 2 * 1024 * 1024 })
  let probe: unknown
  try { probe = JSON.parse(probeResult.stdout) } catch { return null }
  if (!hasSubtitleStream(probe)) return null
  const result = await runCommand(ffmpeg, ['-v', 'error', '-i', filePath, '-map', '0:s:0', '-f', 'webvtt', 'pipe:1'], { signal, maxStdoutBytes: 8 * 1024 * 1024 })
  return result.stdout.replace(/^WEBVTT[^\n]*\n/i, '').trim() || null
}

async function extractAudioWav(filePath: string, outputPath: string, signal?: AbortSignal): Promise<boolean> {
  const ffmpeg = resolveAiLocalTool('ffmpeg')
  if (!ffmpeg) return false
  await runCommand(ffmpeg, ['-y', '-v', 'error', '-i', filePath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outputPath], { signal })
  return fs.existsSync(outputPath)
}

export async function transcribeMediaLocally(filePath: string, signal?: AbortSignal): Promise<string | null> {
  const config = getAiLocalToolsConfig()
  const whisper = resolveAiLocalTool('whisper', config)
  if (!whisper) return null
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-whisper-'))
  try {
    const wavPath = path.join(directory, 'audio.wav')
    if (!await extractAudioWav(filePath, wavPath, signal)) return null
    const base = path.join(directory, 'transcript')
    if (/whisper-cli|main/i.test(path.basename(whisper))) {
      if (!config.whisperModelPath) throw new Error('whisper.cpp 需要配置 GGML 模型文件')
      await runCommand(whisper, ['-m', config.whisperModelPath, '-f', wavPath, '-l', 'auto', '-osrt', '-of', base], { signal, timeoutMs: 30 * 60_000 })
    } else {
      await runCommand(whisper, [wavPath, '--model', config.whisperModel, '--output_format', 'srt', '--output_dir', directory], { signal, timeoutMs: 30 * 60_000 })
    }
    // Preserve the model's segment times so citations can seek into the original media.
    const candidates = ['transcript.srt', 'audio.srt', ...fs.readdirSync(directory).filter(name => name.endsWith('.srt')), 'transcript.txt', 'audio.txt']
      .map(name => path.join(directory, name))
    const output = candidates.find(candidate => fs.existsSync(candidate))
    return output ? fs.readFileSync(output, 'utf8').trim() || null : null
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

export async function convertLegacyOfficeLocally(filePath: string, extension: string, signal?: AbortSignal): Promise<{ filePath: string; cleanup: () => void } | null> {
  const executable = resolveAiLocalTool('libreoffice')
  if (!executable) return null
  const targetExtension = extension === 'doc' ? 'docx' : extension === 'xls' ? 'xlsx' : extension === 'ppt' ? 'pptx' : ''
  if (!targetExtension) return null
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panlite-office-'))
  const cleanup = () => fs.rmSync(directory, { recursive: true, force: true })
  try {
    await runCommand(executable, ['--headless', '--convert-to', targetExtension, '--outdir', directory, filePath], { signal })
    const output = fs.readdirSync(directory).map(name => path.join(directory, name)).find(candidate => path.extname(candidate).slice(1).toLowerCase() === targetExtension)
    if (!output) throw new Error('LibreOffice 未生成转换后的文件')
    return { filePath: output, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
