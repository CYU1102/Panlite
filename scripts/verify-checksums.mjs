import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { finished } from 'node:stream/promises'

const checksumName = 'SHA256SUMS.txt'

function inside(directory, file) {
  const path = relative(directory, file)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

function checksumPath(value) {
  const parts = value.split('/')
  if (isAbsolute(value) || /[<>:"\\|?*]/.test(value) || [...value].some(character => character.charCodeAt(0) <= 31)
    || parts.some(part => !part || part === '.' || part === '..' || /[ .]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe checksum path: ${value}`)
  }
  return parts
}

async function ordinaryFile(directory, parts, label) {
  let file = directory
  for (let index = 0; index < parts.length; index++) {
    file = join(file, parts[index])
    let info
    try { info = await lstat(file) }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Missing checksum file: ${label}`, { cause: error })
      throw error
    }
    if (info.isSymbolicLink()) throw new Error(`Checksum paths must not contain symbolic links or junctions: ${label}`)
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw new Error(`Checksum target is not an ordinary file: ${label}`)
  }
  const canonical = await realpath(file)
  if (!inside(directory, canonical)) throw new Error(`Checksum target escapes the release directory: ${label}`)
  return { file, canonical }
}

async function hashFile(file) {
  const hash = createHash('sha256')
  const stream = createReadStream(file)
  const closed = new Promise(done => stream.once('close', done))
  try {
    for await (const chunk of stream) hash.update(chunk)
    await finished(stream)
    return hash.digest('hex')
  } finally {
    if (!stream.closed) stream.destroy()
    await closed
  }
}

async function verifyChecksums(directory) {
  const input = resolve(directory)
  const rootInfo = await lstat(input)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Release directory must be an ordinary directory')
  const root = await realpath(input)
  const manifest = await ordinaryFile(root, [checksumName], checksumName)
  const bytes = await readFile(manifest.file)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const entries = []
  const names = new Set()
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line) continue
    const match = /^([a-f0-9]{64}) {2}(.+)$/i.exec(line)
    if (!match) throw new Error(`Invalid checksum manifest entry at line ${index + 1}`)
    const [, expected, name] = match
    const parts = checksumPath(name)
    const identity = name.toLowerCase()
    if (identity === checksumName.toLowerCase()) throw new Error('Checksum manifest cannot list itself')
    if (names.has(identity)) throw new Error(`Duplicate checksum path: ${name}`)
    names.add(identity)
    entries.push({ name, parts, expected: expected.toLowerCase() })
  }
  if (!entries.length) throw new Error('Checksum manifest contains no files')

  const identities = new Set()
  const files = []
  for (const entry of entries) {
    const { file, canonical } = await ordinaryFile(root, entry.parts, entry.name)
    const identity = canonical.toLowerCase()
    if (identities.has(identity)) throw new Error(`Duplicate checksum file identity: ${entry.name}`)
    identities.add(identity)
    const before = await lstat(file)
    const actual = await hashFile(file)
    const after = await lstat(file)
    const current = await ordinaryFile(root, entry.parts, entry.name)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.canonical !== canonical) {
      throw new Error(`Checksum file changed during verification: ${entry.name}`)
    }
    if (actual !== entry.expected) throw new Error(`Checksum mismatch: ${entry.name}`)
    files.push({ path: entry.name, sha256: actual, bytes: after.size })
  }
  const manifestAfter = await ordinaryFile(root, [checksumName], checksumName)
  if (manifestAfter.canonical !== manifest.canonical || !(await readFile(manifestAfter.file)).equals(bytes)) throw new Error('Checksum manifest changed during verification')
  return { passed: true, directory: root, manifestSha256: createHash('sha256').update(bytes).digest('hex'), verifiedFiles: files.length, files }
}

try {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0].startsWith('--')) throw new Error('Usage: node scripts/verify-checksums.mjs <release-directory>')
  console.log(JSON.stringify(await verifyChecksums(args[0]), null, 2))
} catch (error) {
  console.error(`Checksum verification failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
