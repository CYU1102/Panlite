import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, relative } from 'node:path'

const args = process.argv.slice(2)
if (args.some(arg => arg.startsWith('--') && arg !== '--recursive')) throw new Error('Unknown checksum option')
const directories = args.filter(arg => arg !== '--recursive')
if (directories.length > 1) throw new Error('Pass at most one release directory')
const outputDir = resolve(directories[0] || 'release')
const checksumName = 'SHA256SUMS.txt'
const recursive = process.argv.includes('--recursive')
const excludedNames = new Set([checksumName, 'builder-debug.yml', 'builder-effective-config.yaml'])

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (recursive && entry.isDirectory()) files.push(...await listFiles(path))
    else if (entry.isFile() && !excludedNames.has(entry.name)) files.push(path)
  }
  return files
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

const files = (await listFiles(outputDir)).sort((a, b) => a.localeCompare(b))
if (files.length === 0) throw new Error(`No release files found in ${outputDir}`)

const rows = []
for (const path of files) {
  const info = await stat(path)
  const digest = await hashFile(path)
  rows.push(`${digest}  ${relative(outputDir, path).replaceAll('\\', '/')}`)
  console.log(`${basename(path)} (${(info.size / 1024 / 1024).toFixed(2)} MB) ${digest}`)
}

await writeFile(join(outputDir, checksumName), `${rows.join('\n')}\n`, 'utf8')
console.log(`Wrote ${join(outputDir, checksumName)}`)
