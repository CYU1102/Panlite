import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourceDirectories = ['src/', 'scripts/', 'build/', 'docs/', '.github/']
const rootFiles = new Set(['package.json', 'package-lock.json', 'README.md', 'UPGRADE_PLAN.md', 'CHANGELOG.md',
  'LICENSE', '.npmrc', '.gitignore', 'eslint.config.mjs', 'vite.config.ts', 'vitest.config.ts',
  'start.bat', 'build.bat', 'PanLite.code-workspace',
  'tsconfig.json', 'tsconfig.node.json', 'electron-builder.yml', 'electron-builder.mac.yml', 'electron-builder.release.cjs', 'index.html'])
export const isReleaseSourcePath = path => rootFiles.has(path) || sourceDirectories.some(directory => path.startsWith(directory))

/** Hash the complete non-ignored source tree, including uncommitted new files. */
export async function collectSourceProvenance(directory = root) {
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', windowsHide: true })
  const paths = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(isReleaseSourcePath))].sort()
  const files = []
  for (const path of paths) {
    let info
    try { info = await lstat(join(directory, path)) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source provenance requires ordinary files: ${path}`)
    files.push({ path, sha256: hash(await readFile(join(directory, path))) })
  }
  return { revision: git(['rev-parse', 'HEAD']).trim(), dirty: Boolean(git(['status', '--porcelain']).trim()),
    sourceSha256: hash(JSON.stringify(files)), files }
}

export async function writeBuildProvenance(output, options = {}) {
  const source = await collectSourceProvenance(options.root || root)
  if (options.requireClean && source.dirty) throw new Error('Release provenance requires a clean committed source tree')
  if (options.expectedRevision && source.revision !== options.expectedRevision) throw new Error('Build revision differs from the CI source revision')
  const pkg = JSON.parse(await readFile(join(options.root || root, 'package.json'), 'utf8'))
  const report = { createdAt: new Date().toISOString(), version: pkg.version, channel: 'windows-unsigned',
    releaseEligibleSource: !source.dirty, node: process.version, platform: process.platform, arch: process.arch,
    lockfileSha256: hash(await readFile(join(options.root || root, 'package-lock.json'))), ...source }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

export async function verifyBuildProvenance(output, options = {}) {
  const before = JSON.parse(await readFile(output, 'utf8'))
  const after = await collectSourceProvenance(options.root || root)
  if (before.sourceSha256 !== after.sourceSha256 || before.revision !== after.revision) throw new Error('Source changed after the build provenance was captured')
  if (options.requireClean && (before.dirty || after.dirty)) throw new Error('Release provenance requires a clean committed source tree')
  return after
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const requireClean = args.includes('--require-clean')
  const verify = args.includes('--verify')
  const positional = args.filter(value => !value.startsWith('--'))
  if (args.some(value => value.startsWith('--') && !['--require-clean', '--verify'].includes(value)) || positional.length > 1) {
    throw new Error('Usage: node scripts/write-build-provenance.mjs [report.json] [--require-clean] [--verify]')
  }
  const output = resolve(positional[0] || 'release/build-provenance.json')
  if (verify) {
    const after = await verifyBuildProvenance(output, { requireClean })
    console.log(`Source verified: ${after.revision}, ${after.files.length} files, SHA-256 ${after.sourceSha256}`)
  } else {
    const report = await writeBuildProvenance(output, { requireClean, expectedRevision: process.env.GITHUB_SHA })
    console.log(`Source captured: ${report.revision}, ${report.files.length} files, release eligible source: ${report.releaseEligibleSource}`)
  }
}
