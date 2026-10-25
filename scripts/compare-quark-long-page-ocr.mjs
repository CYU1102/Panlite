import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { textMetrics } from './ocr-accuracy-metrics.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, 'output/quark-long-page-ocr')
const reference = JSON.parse(fs.readFileSync(path.join(root, 'output/quark-document-acceptance/visual-reference.json'), 'utf8'))
const additionalReference = JSON.parse(fs.readFileSync(path.join(output, 'visual-ground-truth.json'), 'utf8'))
const regions = [...reference.regions.map(region => ({ ...region, group: 'fixed-11-regions' })), ...additionalReference.items.map(region => ({ id: region.id, text: region.expected, sourceCrop: region.location, group: 'fixed-3-top-bullets' }))]
const files = {
  'previous-pdf': 'output/quark-document-acceptance/quark-guide-pdf.parser.txt',
  'tiled-pdf': 'output/quark-long-page-ocr/after/quark-guide-pdf.parser.txt',
  'original-png': 'output/quark-document-acceptance/quark-guide-png.parser.txt',
  'width1125-pdf': 'output/quark-long-page-ocr/width-1125/parser.txt',
  'width1500-pdf': 'output/quark-long-page-ocr/width-1500/parser.txt',
}
const compact = value => value.replace(/\s/gu, '')
const results = []
for (const [stage, filename] of Object.entries(files)) {
  if (!fs.existsSync(path.join(root, filename))) continue
  const text = fs.readFileSync(path.join(root, filename), 'utf8')
  const lines = text.split(/\r?\n/)
  for (const region of regions) {
    let best
    // The reference was fixed visually before this OCR run. Alignment searches
    // only existing contiguous 1–3 lines; it never rewrites recognized text.
    for (let index = 0; index < lines.length; index++) {
      for (let count = 1; count <= 3 && index + count <= lines.length; count++) {
        const actual = lines.slice(index, index + count).join('\n')
        if (!actual.trim() || compact(actual).length > compact(region.text).length * 2 + 20) continue
        const metrics = textMetrics(region.text, actual)
        if (!best || metrics.whitespaceInsensitiveCharacterErrors < best.metrics.whitespaceInsensitiveCharacterErrors) best = { line: index + 1, endLine: index + count, recognized: actual, metrics }
      }
    }
    results.push({ stage, group: region.group, regionId: region.id, sourceCrop: region.sourceCrop, exactWhitespaceInsensitiveHit: compact(text).includes(compact(region.text)), ...best })
  }
}
const stages = [...new Set(results.map(item => item.stage))]
const summary = stages.flatMap(stage => ['fixed-11-regions', 'fixed-3-top-bullets'].map(group => {
  const selected = results.filter(item => item.stage === stage && item.group === group)
  return { stage, group, exactHits: selected.filter(item => item.exactWhitespaceInsensitiveHit).length, regions: selected.length, characterErrors: selected.reduce((sum, item) => sum + item.metrics.whitespaceInsensitiveCharacterErrors, 0), referenceCharacters: selected.reduce((sum, item) => sum + item.metrics.whitespaceInsensitiveReferenceCharacters, 0) }
}))
const report = { method: 'Eleven fixed visually transcribed regions, not whole-page ground truth. Exact hits remove whitespace only. Local edit distance uses the best existing contiguous 1–3 parser lines as alignment; values are not an overall OCR accuracy rate.', reference: 'output/quark-document-acceptance/visual-reference.json', summary, results }
fs.writeFileSync(path.join(output, 'regional-comparison.json'), JSON.stringify(report, null, 2))
const rows = summary.map(item => `| ${item.stage} | ${item.group} | ${item.exactHits}/${item.regions} | ${item.characterErrors}/${item.referenceCharacters} |`)
const detail = regions.map(region => `| ${region.id} | ${stages.map(stage => { const value = results.find(item => item.stage === stage && item.regionId === region.id); return `${value.exactWhitespaceInsensitiveHit ? '精确命中' : `${value.metrics.whitespaceInsensitiveCharacterErrors} 字符差异`}（行 ${value.line}–${value.endLine}）` }).join(' | ')} |`)
fs.writeFileSync(path.join(output, 'regional-comparison.md'), `# 真实长页 PDF 固定区域对照\n\n11 段 reference 在新 OCR 前由原 PNG 目视固定，另有3段直接PDF渲染图预先目视固定的顶部原文，分别统计；仅移除空白，保留标点、数字、大小写。局部编辑距离通过原解析结果连续 1–3 行对齐，未改写 OCR 输出；不能称为整页准确率。未识别区域可能没有可靠的近邻行（例如底部设备文字），请结合精确命中和原图阅读，不能将近邻行差异当作该区域逐字准确率。\n\n| 结果 | 固定参考组 | 区域精确命中 | 局部字符差异/参考字符 |\n|---|---|---:|---:|\n${rows.join('\n')}\n\n| 区域 | ${stages.join(' | ')} |\n|---|${stages.map(() => '---|').join('')}\n${detail.join('\n')}\n`)
process.stdout.write(`${JSON.stringify(summary)}\n`)
