import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { textMetrics } from './ocr-accuracy-metrics.mjs'

// Read the existing frozen fixtures. Never regenerate samples or change thresholds here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => arg.startsWith('--') ? [arg.slice(2), all[index + 1]] : null).filter(Boolean))
const directory = path.resolve(root, args.output || 'output/ocr-acceptance')
const output = path.join(directory, 'experiments')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'))
const exec = promisify(execFile)
const run = (command, parameters) => exec(command, parameters, { windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TESSDATA_PREFIX: baseline.tessdata } })
fs.mkdirSync(output, { recursive: true })
const results = []
for (const fixture of manifest.cases) {
  const prefix = path.join(output, `${fixture.id}.pdf-render`)
  // Exactly the same render dimensions as the application's current PDF OCR helper.
  await run(baseline.pdftoppm, ['-f', String(fixture.pageNumber), '-l', String(fixture.pageNumber), '-singlefile', '-scale-to', '3500', '-png', manifest.pdf, prefix])
  for (const [source, imagePath] of [['image', fixture.image], ['pdf-render', `${prefix}.png`]]) {
    for (const psm of [3, 6]) {
      const outputBase = path.join(output, `${fixture.id}.${source}.psm${psm}`)
      const started = Date.now()
      let recognized = ''
      let error
      try {
        const response = await run(baseline.tesseract, [imagePath, outputBase, '-l', manifest.language, '--psm', String(psm), 'txt', 'tsv'])
        fs.writeFileSync(`${outputBase}.stderr.txt`, response.stderr)
        recognized = fs.readFileSync(`${outputBase}.txt`, 'utf8')
      } catch (cause) { error = cause.message }
      const metrics = textMetrics(fixture.truth, recognized)
      results.push({ caseId: fixture.id, source, psm, durationMs: Date.now() - started, ...metrics, maximumWhitespaceInsensitiveCer: fixture.maximumWhitespaceInsensitiveCer, passed: !error && metrics.whitespaceInsensitiveCer <= fixture.maximumWhitespaceInsensitiveCer && metrics.numericTokensExact && metrics.amountTokensExact, ...(error ? { error } : {}) })
    }
  }
}
const report = { createdAt: new Date().toISOString(), syntheticOnly: true, onlineModelsUsed: false, productionCodeModified: false, fixtureManifest: path.join(directory, 'manifest.json'), baselineReport: path.join(directory, 'report.json'), results }
fs.writeFileSync(path.join(output, 'psm-comparison.json'), JSON.stringify(report, null, 2))
const rows = results.map(item => `| ${item.caseId} | ${item.source} | ${item.psm} | ${(item.strictCer * 100).toFixed(2)}% | ${(item.whitespaceInsensitiveCer * 100).toFixed(2)}% | ${item.numericTokensExact ? '一致' : '不一致'} | ${item.amountTokensExact ? '一致' : '不一致'} | ${item.durationMs} | ${item.passed ? '通过' : '失败'} |`)
fs.writeFileSync(path.join(output, 'psm-comparison.md'), `# PSM 3 / 6 固定样本对照\n\n相同图片与相同应用尺寸 PDF 渲染页、相同语言包和阈值；首轮失败报告及样本保留不改。此实验不修改生产默认模式。PDF 渲染耗时未计入识别耗时。\n\n| 样本 | 来源 | PSM | 严格 CER | 去空白 CER | 数字序列 | 金额 | 毫秒 | 验收 |\n|---|---|---:|---:|---:|---|---|---:|---|\n${rows.join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ runs: results.length, report: path.join(output, 'psm-comparison.md') })}\n`)
