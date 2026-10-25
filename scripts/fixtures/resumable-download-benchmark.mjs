// Run: node scripts/fixtures/resumable-download-benchmark.mjs [sizeMiB=10240] [scratchRoot=os.tmpdir()]
// Uses a real disk file and loopback Range HTTP. No cloud accounts or SQLite.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { build } from 'esbuild'

const root = path.resolve(import.meta.dirname, '../..')
const sizeMiB = Number(process.argv[2] || 10240)
if (!Number.isInteger(sizeMiB) || sizeMiB < 8 || sizeMiB > 102400) throw new Error('sizeMiB must be an integer from 8 to 102400')
const size = sizeMiB * 1024 * 1024
const chunkSize = Math.min(8 * 1024 * 1024, size / 8)
const scratchRoot = path.resolve(process.argv[3] || os.tmpdir())
await fsp.mkdir(scratchRoot, { recursive: true })
const scratch = await fsp.mkdtemp(path.join(scratchRoot, 'panlite-persistent-bench-'))
const input = path.join(scratch, 'source.bin')
const targetPath = path.join(scratch, 'output.bin')
const resumeRoot = path.join(scratch, 'cache')
const modulePath = path.join(scratch, 'resumable.mjs')
const resumeKey = 'loopback-persistent-benchmark'
const keyDigest = createHash('sha256').update(resumeKey).digest('hex')
const manifestPath = path.join(resumeRoot, `download-${keyDigest}`, 'manifest.json')
const etag = '"benchmark-fixed-version"'
const children = new Set()
const resumedRequests = []
let phase = 'initial'
const server = createServer((request, response) => {
  const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '')
  if (!range || request.headers['if-match'] !== etag) { response.writeHead(400); response.end(); return }
  const start = Number(range[1]); const end = Number(range[2])
  if (start > end || end >= size) { response.writeHead(416); response.end(); return }
  if (phase === 'resumed') resumedRequests.push({ start, end })
  response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, ETag: etag })
  const stream = fs.createReadStream(input, { start, end })
  response.on('close', () => stream.destroy())
  stream.on('error', error => response.destroy(error))
  stream.pipe(response)
})

async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes)
  return hash.digest('hex')
}
async function cleanupScratch() {
  const resolved = path.resolve(scratch)
  if (path.dirname(resolved) !== scratchRoot || !path.basename(resolved).startsWith('panlite-persistent-bench-')) throw new Error('Unsafe scratch cleanup path')
  await fsp.rm(resolved, { recursive: true, force: true })
}
function child(url, killAfterParts) {
  const processChild = fork(path.join(root, 'scripts/fixtures/resumable-download-child.mjs'), [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  children.add(processChild)
  return new Promise((resolve, reject) => {
    let result
    let killed = false
    processChild.on('error', reject)
    processChild.on('message', message => {
      if (message.type === 'error') reject(new Error(message.message))
      if (message.type === 'result') result = message.result
      if (killAfterParts && !killed && message.type === 'checkpoint' && message.completedParts >= killAfterParts) {
        killed = true
        processChild.kill('SIGKILL')
      }
    })
    processChild.on('exit', code => {
      children.delete(processChild)
      if (killed || (code === 0 && result)) resolve(result)
      else reject(new Error(`Benchmark child exited unexpectedly: ${code}`))
    })
    processChild.send({ modulePath, resumeRoot, resumeKey, targetPath, url, totalSize: size, chunkSize, connections: 4, identity: { kind: 'etag', value: etag } })
  })
}

try {
  console.log(`Preparing ${sizeMiB} MiB real fixture (up to ~3x file size temporary disk space).`)
  const fixtureHash = createHash('sha256')
  const block = Buffer.from(Array.from({ length: 1024 * 1024 }, (_, index) => (index * 19 + Math.floor(index / 4096)) % 251))
  const file = await fsp.open(input, 'wx')
  try {
    for (let index = 0; index < sizeMiB; index++) {
      // Distinct MiB boundaries make reordering visible to the final digest.
      block.writeUInt32LE(index, 0)
      let offset = 0
      while (offset < block.length) offset += (await file.write(block, offset, block.length - offset)).bytesWritten
      fixtureHash.update(block)
    }
    await file.sync()
  } finally { await file.close() }
  const expectedSha256 = fixtureHash.digest('hex')
  await build({ entryPoints: [path.join(root, 'src/main/resumable-download.ts')], outfile: modulePath,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'loopback-electron', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const net = { fetch: globalThis.fetch }' }))
    } }],
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}/source`
  const initialStart = performance.now()
  await child(url, 2)
  const initialMs = performance.now() - initialStart
  const saved = JSON.parse(await fsp.readFile(manifestPath, 'utf8'))
  if (!saved.parts.length || saved.parts.length >= Math.ceil(size / chunkSize)) throw new Error('Force-exit did not leave a partially completed fixture')
  const durableBytes = saved.parts.reduce((sum, part) => sum + part.size, 0)
  console.log(`Process forcibly killed; ${saved.parts.length} durable chunks (${durableBytes} bytes). Restarting.`)
  phase = 'resumed'
  const restartStart = performance.now()
  const result = await child(url)
  const resumedMs = performance.now() - restartStart
  const finalSha256 = await fileHash(targetPath)
  const repeated = resumedRequests.filter(range => saved.parts.some(part => range.start <= part.end && range.end >= part.start))
  if (repeated.length) throw new Error(`Already validated ranges were requested again: ${JSON.stringify(repeated)}`)
  if (result.reusedBytes !== durableBytes || result.downloadedBytes !== size - durableBytes) throw new Error('Resume byte accounting mismatch')
  if (finalSha256 !== expectedSha256 || result.sha256 !== expectedSha256) throw new Error('Final SHA-256 differs from source')
  const report = {
    scenario: 'Real disk source; loopback HTTP Range; separate Node processes; forced SIGKILL/TerminateProcess; injected Node fetch. No real provider claims.',
    generatedAt: new Date().toISOString(), node: process.versions.node, platform: process.platform, arch: process.arch,
    sizeMiB, fileSize: size, chunkSize, connections: 4, initialMs, resumedMs,
    durablePartsAtKill: saved.parts.length, durableBytesAtKill: durableBytes,
    reusedBytes: result.reusedBytes, downloadedBytesAfterRestart: result.downloadedBytes,
    resumedRangeRequests: resumedRequests.length, repeatedValidatedRangeRequests: repeated.length,
    expectedSha256, finalSha256, sha256Verified: true,
  }
  const reports = path.join(root, 'dist', 'reports')
  await fsp.mkdir(reports, { recursive: true })
  const reportPath = path.join(reports, `persistent-download-${sizeMiB}MiB.json`)
  await fsp.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  console.log(`Report: ${reportPath}`)
} finally {
  for (const processChild of children) {
    const exited = once(processChild, 'exit')
    processChild.kill('SIGKILL')
    await exited
  }
  server.closeAllConnections()
  if (server.listening) await new Promise(resolve => server.close(resolve))
  await cleanupScratch()
}
