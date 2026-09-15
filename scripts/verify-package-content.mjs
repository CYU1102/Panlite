import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const buildRoot = path.resolve(process.argv[2] || '.')
const output = path.resolve(process.argv[3] || 'release')
const archive = path.join(output, 'win-unpacked/resources/app.asar')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name)
  return entry.isDirectory() ? walk(file) : entry.isFile() && !file.endsWith('.map') ? [file] : []
})
const files = ['dist/main', 'dist/renderer'].flatMap(directory => walk(path.join(buildRoot, directory)))
if (!files.length) throw new Error('No production build files found')
const results = files.map(file => {
  const relative = path.relative(buildRoot, file)
  const expected = digest(fs.readFileSync(file))
  try {
    const actual = digest(asar.extractFile(archive, relative))
    return { path: relative.replaceAll('\\', '/'), sha256: actual, expected, matchesBuild: actual === expected }
  } catch (error) { return { path: relative.replaceAll('\\', '/'), expected, matchesBuild: false, error: error.message } }
})
const unintended = asar.listPackage(archive).filter(file => /[/\\](?:\.local-tools|output|reports|quality|fixtures|ocr-acceptance)[/\\]/.test(file))
const report = { createdAt: new Date().toISOString(), buildRoot, buildFilesVerified: results.length,
  allMatch: results.every(file => file.matchesBuild), unintendedFiles: unintended, files: results }
fs.writeFileSync(path.join(output, 'packaged-content-verification.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ buildFilesVerified: report.buildFilesVerified, allMatch: report.allMatch, unintendedFiles: unintended.length }))
if (!report.allMatch || unintended.length) process.exitCode = 1
