import fs from 'node:fs'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const sizeMiB = Number(process.argv[2] || 256)
if (!Number.isInteger(sizeMiB) || sizeMiB < 32 || sizeMiB > 2048) throw new Error('Size must be an integer from 32 to 2048 MiB')
const scratch = await mkdtemp(join(tmpdir(), 'panlite-transfer-bench-'))
const input = join(scratch, 'input.bin')
const server = createServer((request, response) => {
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '')
  const start = range ? Number(range[1]) : 0
  const end = range ? Number(range[2]) : sizeMiB * 1024 * 1024 - 1
  response.writeHead(range ? 206 : 200, { 'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${sizeMiB * 1024 * 1024}` } : {}) })
  fs.createReadStream(input, { start, end }).pipe(response)
})

async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

try {
  const block = Buffer.alloc(1024 * 1024, 0x5a)
  const descriptor = fs.openSync(input, 'w')
  try { for (let index = 0; index < sizeMiB; index++) fs.writeSync(descriptor, block) } finally { fs.closeSync(descriptor) }
  const expectedHash = await digest(input)
  const compiled = join(scratch, 'chunked-download.mjs')
  await build({ entryPoints: [resolve(root, 'src/main/chunked-download.ts')], outfile: compiled,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'node-http-benchmark', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'benchmark' }))
      builder.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({ contents: 'export const net = { fetch: globalThis.fetch }' }))
    } }],
  })
  const { chunkedDownloadTo } = await import(pathToFileURL(compiled).href)
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const rows = []
  for (const connections of [1, 4]) {
    const targetPath = join(scratch, `output-${connections}.bin`)
    const start = performance.now()
    await chunkedDownloadTo({ url: `http://127.0.0.1:${server.address().port}/file`, targetPath,
      totalSize: sizeMiB * 1024 * 1024, connections })
    const elapsedMs = performance.now() - start
    if (await digest(targetPath) !== expectedHash) throw new Error('Transfer checksum mismatch')
    rows.push({ connections, sizeMiB, elapsedMs, throughputMiBps: sizeMiB / (elapsedMs / 1000), sha256Verified: true })
    console.log(`${connections} connection(s): ${elapsedMs.toFixed(0)} ms, ${rows.at(-1).throughputMiBps.toFixed(1)} MiB/s, SHA-256 verified`)
    await rm(targetPath)
  }
  await mkdir(resolve(root, 'dist/reports'), { recursive: true })
  await writeFile(resolve(root, 'dist/reports/transfer-benchmark.json'), JSON.stringify({
    scenario: 'loopback HTTP Range, Node fetch transport, real chunking/merge code; not provider throughput',
    node: process.versions.node, platform: process.platform, rows,
  }, null, 2) + '\n')
} finally {
  server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(scratch, { recursive: true, force: true })
}
