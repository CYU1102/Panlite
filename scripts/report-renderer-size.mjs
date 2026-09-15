import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { resolve, extname, basename } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'dist/reports/renderer-size.json')
const baselinePath = resolve(root, process.argv[2] || process.env.PANLITE_SIZE_BASELINE || 'benchmarks/renderer-size-baseline.json')
const assets = resolve(root, 'dist/renderer/assets')
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const rows = []
for (const name of await readdir(assets)) {
  if (!['.js', '.css'].includes(extname(name))) continue
  const data = await readFile(resolve(assets, name))
  rows.push({ file: name, bytes: data.length, gzipBytes: gzipSync(data).length })
}
const totals = Object.fromEntries(['.js', '.css'].map(extension => [extension.slice(1), rows
  .filter(row => extname(row.file) === extension)
  .reduce((total, row) => ({ bytes: total.bytes + row.bytes, gzipBytes: total.gzipBytes + row.gzipBytes }), { bytes: 0, gzipBytes: 0 })]))
let baseline
try { baseline = JSON.parse(await readFile(baselinePath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
const comparison = baseline ? Object.fromEntries(Object.entries(totals).map(([kind, value]) => [kind, {
  bytesDelta: value.bytes - baseline.totals[kind].bytes,
  gzipBytesDelta: value.gzipBytes - baseline.totals[kind].gzipBytes,
  percent: Number(((value.bytes / baseline.totals[kind].bytes - 1) * 100).toFixed(2)),
}])) : null
const report = { version: pkg.version, generatedAt: new Date().toISOString(), baseline: baseline ? basename(baselinePath) : null,
  totals, comparison, assets: rows.sort((a, b) => b.bytes - a.bytes) }
await mkdir(resolve(output, '..'), { recursive: true })
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
for (const [kind, value] of Object.entries(totals)) {
  console.log(`${kind.toUpperCase()}: ${(value.bytes / 1024).toFixed(1)} KiB; gzip ${(value.gzipBytes / 1024).toFixed(1)} KiB${comparison ? `; baseline ${comparison[kind].percent > 0 ? '+' : ''}${comparison[kind].percent}%` : '; no baseline supplied'}`)
}
console.log(`Renderer size report: ${output}`)
