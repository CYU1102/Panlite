import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--') ? [arg.slice(2), all[index + 1]] : null).filter(Boolean))
if (!args.manifest || !args.python) throw new Error('Use --manifest <explicit-local-samples.json> --python <python.exe> [--output <directory>]')
const manifest = JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8'))
if (!Array.isArray(manifest.samples) || !manifest.samples.length || manifest.samples.length > 12) throw new Error('Manifest must list 1–12 explicitly authorized local samples')
const output = path.resolve(root, args.output || 'output/local-document-acceptance')
fs.mkdirSync(output, { recursive: true })
const allowed = new Set(['pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt', 'txt', 'md', 'markdown', 'csv', 'json', 'xml', 'log', 'yaml', 'yml', 'html', 'htm', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const toolConfig = { tesseractPath: path.resolve(root, '.local-tools/tesseract/tesseract.exe'), ocrLanguage: 'chi_sim+eng', ...(manifest.tools || {}) }
const bundlePath = path.join(output, 'offline-parser.cjs')
await build({
  stdin: { contents: "export { parseAiDocument } from './src/main/ai/document-parser'; export { resolveAiLocalTool } from './src/main/ai/local-ai-tools'", resolveDir: root, loader: 'ts' },
  outfile: bundlePath, bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
  plugins: [{ name: 'offline-no-user-state', setup(bundler) {
    bundler.onResolve({ filter: /^(\.\.\/db|\.\/ai-provider|electron-log)$/ }, ({ path: imported }) => ({ path: imported, namespace: 'offline' }))
    bundler.onLoad({ filter: /.*/, namespace: 'offline' }, ({ path: imported }) => {
      if (imported === '../db') return { contents: `export function getSetting(key) { return key === 'aiLocalToolsV1' ? {value:${JSON.stringify(JSON.stringify(toolConfig))}} : undefined; } export function setSetting() { throw new Error('User state writes forbidden'); }` }
      if (imported === 'electron-log') return { contents: 'export default {info(){},warn(){},error(){},debug(){}}' }
      return { contents: `export function getAiProviderConfig(){return {type:'openai-compatible',baseUrl:'https://offline.invalid',model:'offline-blocked',transcriptionModel:'offline-blocked'}}; function blocked(){globalThis.__offlineBlockedCalls++;throw new Error('Model calls forbidden by offline acceptance')} export const extractTextFromVisualFile=blocked;export const transcribeMediaFile=blocked;` }
    })
  } }],
})
globalThis.__offlineBlockedCalls = 0
globalThis.fetch = () => { globalThis.__offlineBlockedCalls++; throw new Error('Network requests forbidden by offline acceptance') }
const application = createRequire(import.meta.url)(bundlePath)
const exec = promisify(execFile)
const digest = value => crypto.createHash('sha256').update(value).digest('hex')
const compact = value => value.replace(/\s/gu, '')
const snippet = value => [...value.replace(/[\r\n\t]/g, ' ')].slice(0, 80).join('')
const sampleIds = new Set()
const results = []
for (const sample of manifest.samples) {
  if (typeof sample.id !== 'string' || !/^[a-zA-Z0-9_-]{1,50}$/.test(sample.id) || sampleIds.has(sample.id)) throw new Error('Use a unique non-sensitive sample id')
  sampleIds.add(sample.id)
  const file = path.resolve(sample.path)
  const extension = path.extname(file).slice(1).toLowerCase()
  if (!allowed.has(extension)) throw new Error(`Unsupported sample format: ${extension}`)
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('Samples must be regular local files no larger than 100 MB')
  const before = digest(fs.readFileSync(file))
  const started = Date.now()
  const originalConsole = { log: console.log, warn: console.warn, error: console.error }
  let parsed
  let reference
  let referenceError
  try {
    // PDF libraries may log document-derived diagnostics. Do not disclose those to the terminal.
    console.log = console.warn = console.error = () => {}
    parsed = await application.parseAiDocument(file, extension, { signal: AbortSignal.timeout(180_000) })
    try {
      const response = await exec(args.python, [path.join(root, 'scripts/reference-local-document.py'), file], { windowsHide: true, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 })
      reference = JSON.parse(response.stdout)
    } catch (error) { referenceError = `Independent reference unavailable (${error.code || 'parse error'}); manual review required` }
  } finally { Object.assign(console, originalConsole) }
  const comparisons = []
  const examples = []
  for (const [index, section] of (reference?.sections || []).entries()) {
    const actual = parsed.sections?.find(candidate => section.pageNumber ? candidate.pageNumber === section.pageNumber : candidate.section === section.section) || (!section.pageNumber && index === 0 ? parsed.sections?.[0] : undefined)
    const expected = section.content
    const actualText = actual?.content || ''
    const exact = expected.replace(/\r\n?/g, '\n').trimEnd() === actualText.replace(/\r\n?/g, '\n').trimEnd()
    const whitespaceInsensitiveEqual = compact(expected) === compact(actualText)
    const numericTokens = value => value.match(/\d+(?:\.\d+)?/g) || []
    const amounts = value => value.match(/(?<![\d.])\d+\.\d{2}(?!\d)/g) || []
    comparisons.push({ pageNumber: section.pageNumber, sectionIndex: index + 1, referenceCharacters: [...expected].length, parserCharacters: [...actualText].length, exact, whitespaceInsensitiveEqual, referenceNumericTokenCount: numericTokens(expected).length, numericSequenceEqual: JSON.stringify(numericTokens(expected)) === JSON.stringify(numericTokens(actualText)), twoDecimalAmountSequenceEqual: JSON.stringify(amounts(expected)) === JSON.stringify(amounts(actualText)), referenceSha256: digest(expected), parserSha256: digest(actualText), requiresVisualReview: !expected.trim() || !whitespaceInsensitiveEqual })
    if (!whitespaceInsensitiveEqual && examples.length < 3 && expected.trim()) {
      const expectedLines = expected.split(/\r?\n/)
      const actualLines = actualText.split(/\r?\n/)
      const lineIndex = expectedLines.findIndex((line, row) => compact(line) !== compact(actualLines[row] || ''))
      const row = Math.max(0, lineIndex)
      examples.push({ pageNumber: section.pageNumber, sectionIndex: index + 1, referenceLine: section.sourceRows?.[row] || row + 1, parserLine: row + 1, expected: snippet(expectedLines[row] || ''), actual: snippet(actualLines[row] || '') })
    }
  }
  const after = digest(fs.readFileSync(file))
  const hasReferenceText = comparisons.some(item => item.referenceCharacters)
  let parserRawTextPath
  if (sample.saveRawText === true) {
    parserRawTextPath = path.join(output, `${sample.id}.parser.txt`)
    fs.writeFileSync(parserRawTextPath, (parsed.sections || []).map(section => `${section.pageNumber ? `[Page ${section.pageNumber}]\n` : ''}${section.content}`).join('\n\n'), 'utf8')
  }
  const reviewSamples = []
  if (!hasReferenceText) {
    for (const [index, section] of (parsed.sections || []).entries()) {
      const lines = section.content.split(/\r?\n/)
      const line = lines.findIndex(value => value.trim())
      if (line >= 0) reviewSamples.push({ pageNumber: section.pageNumber, sectionIndex: index + 1, parserLine: line + 1, recognized: snippet(lines[line]), verified: false })
      if (reviewSamples.length >= 3) break
    }
  }
  results.push({ id: sample.id, extension, bytes: stat.size, sha256: before, sourceUnchanged: before === after, durationMs: Date.now() - started, parserStatus: parsed.status, partial: !!parsed.partial, message: snippet(parsed.message || ''), sectionCount: parsed.sections?.length || 0, parserCharacterCount: (parsed.sections || []).reduce((sum, section) => sum + [...section.content].length, 0), parserRawTextPath, referenceSource: reference?.source, referenceError, referenceNotes: reference?.notes, image: reference?.image, pageCount: reference?.pageCount, comparisons, examples, reviewSamples, verdict: !hasReferenceText ? 'requires_visual_ground_truth' : comparisons.every(item => item.whitespaceInsensitiveEqual && !item.requiresVisualReview) ? 'independent_text_agreement_not_accuracy_proof' : 'differences_require_manual_review' })
}
const report = { createdAt: new Date().toISOString(), sampleProvenance: manifest.provenance || 'explicit-local-files-unspecified-source', onlineModelsUsed: false, blockedModelOrNetworkCalls: globalThis.__offlineBlockedCalls, userSettingsReadOrWritten: false, originalsUnchanged: results.every(item => item.sourceUnchanged), method: 'Independent local extraction is a consistency reference, not verified ground truth. No OCR accuracy rate is assigned without visual transcription.', toolPaths: { tesseract: application.resolveAiLocalTool('tesseract'), pdftoppm: application.resolveAiLocalTool('pdftoppm'), libreoffice: application.resolveAiLocalTool('libreoffice') }, results }
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
const escape = value => String(value).replace(/[|\r\n]/g, ' ').replace(/([\\`*_[\]{}])/g, '\\$1').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const rows = results.map(item => `| ${item.id} | ${item.extension} | ${item.parserStatus} | ${item.sectionCount} | ${item.partial ? '是' : '否'} | ${item.verdict} |`)
const evidence = results.flatMap(item => item.examples.map(example => `- ${item.id}，${example.pageNumber ? `第 ${example.pageNumber} 页，` : `第 ${example.sectionIndex} 节，`}参考行 ${example.referenceLine} / 解析行 ${example.parserLine}：参考「${escape(example.expected)}」；解析「${escape(example.actual)}」。`))
evidence.push(...results.flatMap(item => item.reviewSamples.map(example => `- ${item.id}，${example.pageNumber ? `第 ${example.pageNumber} 页，` : `第 ${example.sectionIndex} 节，`}解析行 ${example.parserLine}：待目视核对「${escape(example.recognized)}」，未验证准确性。`)))
fs.writeFileSync(path.join(output, 'report.md'), `# 本地样本离线验收\n\n仅只读测试明确列出的本地副本；模型和网络调用被阻止。独立工具结果只用于交叉比对，一致不代表已证明准确。扫描 PDF / 图片需人工核对，未伪造准确率。报告不包含完整正文，差异最多每文件 3 处、每片段 80 字。\n\n| 样本编号 | 格式 | 状态 | 文本节数 | 部分结果 | 结论 |\n|---|---|---|---:|---|---|\n${rows.join('\n')}\n\n${evidence.join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ report: path.join(output, 'report.md'), samples: results.length, originalsUnchanged: report.originalsUnchanged, blockedCalls: report.blockedModelOrNetworkCalls })}\n`)
if (!report.originalsUnchanged || report.blockedModelOrNetworkCalls) process.exitCode = 1
