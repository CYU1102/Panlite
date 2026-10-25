import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { textMetrics } from './ocr-accuracy-metrics.mjs'

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = Object.fromEntries(process.argv.slice(2).map((arg, index, args) => arg.startsWith('--') ? [arg.slice(2), args[index + 1]] : null).filter(Boolean))
const output = path.resolve(root, options.output || 'output/ocr-acceptance')
const tesseract = path.resolve(root, options.tesseract || '.local-tools/tesseract/tesseract.exe')
const pdftoppm = options.pdftoppm ? path.resolve(options.pdftoppm) : ''
const python = options.python || process.env.PANLITE_TEST_PYTHON || 'python'
const font = options.font || path.join(process.env.WINDIR || 'C:/Windows', 'Fonts/msyh.ttc')
const tessdata = path.resolve(options.tessdata || path.join(path.dirname(tesseract), 'tessdata'))
const run = (executable, args) => exec(executable, args, { windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TESSDATA_PREFIX: tessdata } })
fs.mkdirSync(output, { recursive: true })


function assess(fixture, recognized, stage, details = {}) {
  const metrics = textMetrics(fixture.truth, recognized)
  const passed = metrics.whitespaceInsensitiveCer <= fixture.maximumWhitespaceInsensitiveCer && metrics.numericTokensExact && metrics.amountTokensExact && !details.error
  fs.writeFileSync(path.join(output, `${fixture.id}.${stage}.txt`), recognized, 'utf8')
  return { caseId: fixture.id, pageNumber: fixture.pageNumber, stage, passed, maximumWhitespaceInsensitiveCer: fixture.maximumWhitespaceInsensitiveCer, ...metrics, ...details }
}

function markdown(report) {
  const rows = report.results.map(item => `| ${item.caseId} | ${item.stage} | ${(item.strictCer * 100).toFixed(2)}% | ${(item.whitespaceInsensitiveCer * 100).toFixed(2)}% | ${item.numericTokensExact ? '一致' : '不一致'} | ${item.amountTokensExact ? '一致' : '不一致'} | ${item.passed ? '通过' : '失败'} |`)
  const failures = report.results.filter(item => !item.passed).map(item => `- **${item.caseId} / ${item.stage}**：CER ${(item.whitespaceInsensitiveCer * 100).toFixed(2)}%，阈值 ${(item.maximumWhitespaceInsensitiveCer * 100).toFixed(2)}%；数字期望 ${JSON.stringify(item.expectedNumbers)}，实际 ${JSON.stringify(item.actualNumbers)}${item.error ? `；${item.error}` : ''}`)
  return `# 本地 OCR 合成样本验收\n\n生成时间：${report.createdAt}\n\nTesseract：${report.tesseractVersion}\n\n样本固定为合成文档，不能代表用户文件或所有扫描件。未调用在线模型。应用 PDF 链路仅注入本地工具路径和语言配置，实际运行 Poppler 与 Tesseract，没有模拟识别结果。\n\n严格 CER 保留字符与排版空白；另报告仅移除空白后的 CER，不修正标点、大小写或易混淆数字。数字及两位金额必须按原顺序全部精确匹配。引擎置信度不是准确率。\n\n| 样本 | 链路 | 严格 CER | 去空白 CER | 数字序列 | 两位金额 | 验收 |\n|---|---|---:|---:|---|---|---|\n${rows.join('\n')}\n\n${failures.length ? `## 未通过项目\n\n${failures.join('\n')}\n` : '所有固定合成案例达到预先声明的验收条件。\n'}\n原始识别正文、直接 Tesseract TSV、固定 ground truth 和 JSON 指标均保存在同一目录。\n`
}

async function main() {
  // Keep each prior run, including failures, before regenerating deterministic fixtures.
  const priorReportPath = path.join(output, 'report.json')
  if (fs.existsSync(priorReportPath)) {
    const priorReport = JSON.parse(fs.readFileSync(priorReportPath, 'utf8'))
    const archive = path.join(output, 'runs', priorReport.createdAt.replace(/[^0-9TZ]/g, ''))
    fs.mkdirSync(archive, { recursive: true })
    for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
      if (entry.isFile() && entry.name !== 'application-ocr-runner.cjs') {
        const destination = path.join(archive, entry.name)
        if (!fs.existsSync(destination)) fs.copyFileSync(path.join(output, entry.name), destination)
      }
    }
  }
  const generated = await exec(python, [path.join(root, 'scripts/generate-ocr-fixtures.py'), '--output', output, '--font', font], { windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 })
  process.stdout.write(generated.stdout)
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'))
  const version = await run(tesseract, ['--version'])
  const languageList = await run(tesseract, ['--list-langs'])
  fs.writeFileSync(path.join(output, 'tesseract-languages.txt'), `${languageList.stdout}\n${languageList.stderr}`)
  for (const language of ['chi_sim', 'eng']) if (!new RegExp(`^${language}$`, 'm').test(languageList.stdout.replace(/\r/g, ''))) throw new Error(`Missing required OCR language: ${language}`)
  const config = { tesseractPath: tesseract, pdftoppmPath: pdftoppm, ocrLanguage: manifest.language }
  const bundlePath = path.join(output, 'application-ocr-runner.cjs')
  await build({
    stdin: { contents: "export { ocrPdfLocally, resolveAiLocalTool } from './src/main/ai/local-ai-tools'", resolveDir: root, loader: 'ts' },
    outfile: bundlePath, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent',
    plugins: [{ name: 'synthetic-tool-config-only', setup(bundler) {
      bundler.onResolve({ filter: /^\.\.\/db$/ }, args => {
        if (args.importer.endsWith('local-ai-tools.ts')) return { path: 'synthetic-config', namespace: 'acceptance' }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'acceptance' }, () => ({ contents: `export function getSetting(key) { return key === 'aiLocalToolsV1' ? { value: ${JSON.stringify(JSON.stringify(config))} } : undefined; } export function setSetting() { throw new Error('Acceptance must not write user settings'); }`, loader: 'js' }))
    } }],
  })
  process.env.TESSDATA_PREFIX = tessdata
  const application = require(bundlePath)
  const detectedPoppler = application.resolveAiLocalTool('pdftoppm')
  if (!detectedPoppler) throw new Error('Poppler is required to exercise the real application PDF OCR chain; pass --pdftoppm')
  const results = []
  for (const fixture of manifest.cases) {
    const started = Date.now()
    const outputBase = path.join(output, `${fixture.id}.tesseract`)
    try {
      const response = await run(tesseract, [fixture.image, outputBase, '-l', manifest.language, '--psm', '3', 'txt', 'tsv'])
      fs.writeFileSync(`${outputBase}.stderr.txt`, response.stderr)
      results.push(assess(fixture, fs.readFileSync(`${outputBase}.txt`, 'utf8'), 'direct', { durationMs: Date.now() - started }))
    } catch (error) {
      results.push(assess(fixture, '', 'direct', { durationMs: Date.now() - started, error: error.message }))
    }
  }
  const pdfStarted = Date.now()
  let pages = []
  let pdfError
  try { pages = await application.ocrPdfLocally(manifest.pdf, undefined, manifest.cases.map(item => item.pageNumber)) || [] }
  catch (error) { pdfError = error.message }
  fs.writeFileSync(path.join(output, 'application-pdf-pages.json'), JSON.stringify(pages, null, 2))
  for (const fixture of manifest.cases) {
    const page = pages.find(item => item.pageNumber === fixture.pageNumber)
    results.push(assess(fixture, page?.content || '', 'application-pdf', { ...(pdfError ? { error: pdfError } : {}), engineConfidence: page?.confidence, engineWarnings: page?.warnings || [] }))
  }
  const report = {
    createdAt: new Date().toISOString(), syntheticOnly: true, onlineModelsUsed: false,
    tesseract, tessdata, pdftoppm: detectedPoppler,
    tesseractVersion: `${version.stdout}\n${version.stderr}`.split(/\r?\n/).find(Boolean),
    pdfDurationMs: Date.now() - pdfStarted,
    manifest: path.join(output, 'manifest.json'),
    passed: results.every(item => item.passed), results,
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(output, 'report.md'), markdown(report))
  process.stdout.write(`${JSON.stringify({ passed: report.passed, runs: results.length, failures: results.filter(item => !item.passed).map(item => `${item.caseId}/${item.stage}`), report: path.join(output, 'report.md') }, null, 2)}\n`)
  if (!report.passed) process.exitCode = 1
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1 })
