import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { textMetrics } from './ocr-accuracy-metrics.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(root, 'output/ocr-acceptance')
const output = path.join(directory, 'experiments')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'))
const fixture = manifest.cases.find(item => item.id === 'clean-chinese')
const exec = promisify(execFile)
const results = []
for (const [source, image] of [['image', fixture.image], ['pdf-render', path.join(output, `${fixture.id}.pdf-render.png`)]]) {
  for (const language of ['chi_sim', 'chi_sim+eng', 'eng+chi_sim']) {
    for (const psm of [3, 6]) {
      const outputBase = path.join(output, `${fixture.id}.${source}.${language.replaceAll('+', '-')}.psm${psm}`)
      const started = Date.now()
      const response = await exec(baseline.tesseract, [image, outputBase, '-l', language, '--psm', String(psm), 'txt', 'tsv'], { windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, TESSDATA_PREFIX: baseline.tessdata } })
      fs.writeFileSync(`${outputBase}.stderr.txt`, response.stderr)
      const metrics = textMetrics(fixture.truth, fs.readFileSync(`${outputBase}.txt`, 'utf8'))
      results.push({ caseId: fixture.id, source, language, psm, durationMs: Date.now() - started, ...metrics, maximumWhitespaceInsensitiveCer: fixture.maximumWhitespaceInsensitiveCer, passed: metrics.whitespaceInsensitiveCer <= fixture.maximumWhitespaceInsensitiveCer && metrics.numericTokensExact && metrics.amountTokensExact })
    }
  }
}
fs.writeFileSync(path.join(output, 'language-comparison.json'), JSON.stringify({ createdAt: new Date().toISOString(), syntheticOnly: true, onlineModelsUsed: false, productionCodeModified: false, results }, null, 2))
const rows = results.map(item => `| ${item.source} | ${item.language} | ${item.psm} | ${(item.whitespaceInsensitiveCer * 100).toFixed(2)}% | ${item.numericTokensExact ? '一致' : '不一致'} | ${item.amountTokensExact ? '一致' : '不一致'} | ${item.durationMs} | ${item.passed ? '通过' : '失败'} |`)
fs.writeFileSync(path.join(output, 'language-comparison.md'), `# 清晰中文语言组合对照\n\n沿用最初固定 GT/阈值，不做标点归一或自动纠错。\n\n| 来源 | 语言 | PSM | 去空白 CER | 数字 | 金额 | 毫秒 | 验收 |\n|---|---|---:|---:|---|---|---:|---|\n${rows.join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ runs: results.length, report: path.join(output, 'language-comparison.md') })}\n`)
