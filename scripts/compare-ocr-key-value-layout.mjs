import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { inspectKeyValueLayout } from './ocr-key-value-layout.mjs'
import { textMetrics } from './ocr-accuracy-metrics.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const directory = path.join(root, 'output/ocr-acceptance')
const output = path.join(directory, 'experiments')
const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
const results = []
for (const fixture of manifest.cases) {
  for (const source of ['image', 'pdf-render']) {
    const original = fs.readFileSync(path.join(output, `${fixture.id}.${source}.psm3.txt`), 'utf8')
    const result = inspectKeyValueLayout(fs.readFileSync(path.join(output, `${fixture.id}.${source}.psm3.tsv`), 'utf8'))
    if (result.suspected) {
      assert.deepEqual([...result.proposedTokenIds].sort((a, b) => a - b), result.originalTokenIds)
      fs.writeFileSync(path.join(output, `${fixture.id}.${source}.proposed-key-value.txt`), result.proposedText)
    }
    results.push({ caseId: fixture.id, source, originalMetrics: textMetrics(fixture.truth, original), proposedMetrics: result.suspected ? textMetrics(fixture.truth, result.proposedText) : null, ...result })
  }
}

function syntheticTsv(blocks) {
  const rows = ['level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext']
  blocks.forEach((lines, blockIndex) => lines.forEach((line, lineIndex) => {
    const geometry = [line.left, line.top, line.width || 120, line.height || 20]
    rows.push([4, 1, blockIndex + 1, 1, lineIndex + 1, 0, ...geometry, -1, ''].join('\t'))
    rows.push([5, 1, blockIndex + 1, 1, lineIndex + 1, 1, ...geometry, 90, line.text].join('\t'))
  }))
  return `${rows.join('\n')}\n`
}
const labelBlock = ['数量：', '单价：', '合计：'].map((text, index) => ({ text, left: 0, top: index * 40 }))
const valueBlock = ['12', '128.50', '1542.00'].map((text, index) => ({ text, left: 200, top: index * 40 }))
const counterexamples = [
  { name: 'Actual two-column prose', expected: false, blocks: [labelBlock.map((line, index) => ({ ...line, text: ['左栏正文第一行', '继续阅读第二行', '最后一行说明'][index] })), valueBlock.map(line => ({ ...line, text: '独立右栏正文' }))] },
  { name: 'Three-column table has ambiguous right-hand matches', expected: false, blocks: [labelBlock, valueBlock, valueBlock.map(line => ({ ...line, left: 400 }))] },
  { name: 'Adjacent heights but different horizontal rows', expected: false, blocks: [labelBlock, valueBlock.map(line => ({ ...line, top: line.top + 12 }))] },
  { name: 'Vertical or rotated narrow label boxes', expected: false, blocks: [labelBlock.map(line => ({ ...line, width: 20, height: 100 })), valueBlock] },
  { name: 'Ambiguous glossary left column and independent right number list', expected: true, blocks: [labelBlock, valueBlock], semanticallySafeToReorder: false },
]
for (const counterexample of counterexamples) {
  const detection = inspectKeyValueLayout(syntheticTsv(counterexample.blocks))
  assert.equal(detection.suspected, counterexample.expected, counterexample.name)
  if (detection.suspected) assert.equal(detection.safeToAutomaticallyReorder, false)
  counterexample.result = detection.suspected
  delete counterexample.blocks
}
const report = { createdAt: new Date().toISOString(), syntheticOnly: true, productionCodeModified: false, conclusion: 'Geometry flags a possible reading-order issue, but identical geometric evidence can represent independent columns. Keep original text and warn; do not automatically reorder.', counterexamples, results }
fs.writeFileSync(path.join(output, 'key-value-layout.json'), JSON.stringify(report, null, 2))
const rows = results.map(item => `| ${item.caseId} | ${item.source} | ${item.suspected ? item.pairCount : '未检测'} | ${(item.originalMetrics.whitespaceInsensitiveCer * 100).toFixed(2)}% | ${item.proposedMetrics ? `${(item.proposedMetrics.whitespaceInsensitiveCer * 100).toFixed(2)}%` : '-'} | ${item.proposedMetrics ? item.proposedMetrics.numericTokensExact ? '一致' : '不一致' : '-'} |`)
fs.writeFileSync(path.join(output, 'key-value-layout.md'), `# 标签值几何对照（仅实验）\n\n仅检测完整短标签块、连续不少于 3 行冒号、唯一同水平右侧内容，保留全部非空 token；不改字形、数字、阈值或生产代码。\n\n| 样本 | 来源 | 候选对应行数 | 原去空白 CER | 试排 CER | 试排数字 |\n|---|---|---:|---:|---:|---|\n${rows.join('\n')}\n\n5 个反例检查通过：正常双栏正文、三列表格、近邻不同行、竖排框均不重排；“左栏术语标签 + 独立右栏数字列表”具有与键值表相同的几何信息，无法据此确定语义配对。结论：只能提示疑似阅读顺序问题并保留原始 TXT，不能安全默认采用试排文本。\n`)
process.stdout.write(`${JSON.stringify({ cases: results.length, counterexamples: counterexamples.length, report: path.join(output, 'key-value-layout.md') })}\n`)
