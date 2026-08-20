import { readdir, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const unpackedDir = resolve(root, process.argv[2] || 'release/win-unpacked')
const resourcesDir = resolve(unpackedDir, 'resources')

async function sizeOf(path) {
  const info = await stat(path)
  if (info.isFile()) return info.size

  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await sizeOf(resolve(path, entry.name))
  }
  return total
}

function format(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

async function reportDirectory(title, directory) {
  const entries = await readdir(directory)
  const rows = []
  for (const entry of entries) {
    const bytes = await sizeOf(resolve(directory, entry))
    rows.push({ name: basename(entry), bytes })
  }

  rows.sort((a, b) => b.bytes - a.bytes)
  const total = rows.reduce((sum, row) => sum + row.bytes, 0)

  console.log(`\n${title}:`)
  for (const row of rows) console.log(`  ${row.name.padEnd(28)} ${format(row.bytes)}`)
  console.log(`  ${'TOTAL'.padEnd(28)} ${format(total)}`)
  return total
}

try {
  await reportDirectory(`Packaged application (${unpackedDir})`, unpackedDir)
  await reportDirectory('Packaged resources', resourcesDir)
  console.log('')
} catch (error) {
  console.error(`Unable to inspect ${unpackedDir}:`, error.message)
  process.exitCode = 1
}
