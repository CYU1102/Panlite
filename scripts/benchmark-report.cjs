const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { cpus, platform, arch, release, totalmem } = require('node:os')
const { resolve } = require('node:path')

const sha256 = value => createHash('sha256').update(value).digest('hex')
const round = value => Math.round(value * 100) / 100

function statistics(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Benchmark samples must contain finite nonnegative durations')
  const sorted = [...values].sort((a, b) => a - b)
  return { count: sorted.length, p50Ms: round(sorted[Math.ceil(sorted.length * .5) - 1]), p95Ms: round(sorted[Math.ceil(sorted.length * .95) - 1]), maxMs: round(sorted[sorted.length - 1]) }
}

function metadata(root, fixture, files) {
  let revision = null, dirty = null
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim()
    dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, windowsHide: true, encoding: 'utf8' }).trim())
  } catch { /* Source archives are valid inputs; do not invent a Git revision. */ }
  const sources = Object.fromEntries([...new Set([...files, 'package.json', 'package-lock.json'])].sort().map(file => [file, sha256(readFileSync(resolve(root, file)))]))
  return {
    fixture, fixtureSha256: sha256(JSON.stringify(fixture)),
    environment: { platform: platform(), arch: arch(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), node: process.version, electron: process.versions.electron ?? null, moduleAbi: process.versions.modules },
    source: { revision, dirty, files: sources, fingerprint: sha256(JSON.stringify(sources)) },
  }
}

function readBaseline(filename) {
  if (!filename) return null
  return JSON.parse(readFileSync(filename, 'utf8'))
}

function compareReports(current, baseline, paths, thresholdPercent = 20) {
  if (!baseline) return { status: 'unavailable', reason: 'No previous candidate report was supplied; no speedup claim is made.' }
  const reasons = []
  if (current.schema !== baseline.schema || current.benchmark !== baseline.benchmark) reasons.push('benchmark schema/name differ')
  if (!current.fixtureSha256 || current.fixtureSha256 !== baseline.fixtureSha256) reasons.push('fixed fixture/configuration differ')
  if (JSON.stringify(current.environment) !== JSON.stringify(baseline.environment)) reasons.push('machine/runtime configuration differ')
  if (reasons.length) return { status: 'incompatible', reasons }
  const valueAt = (object, path) => path.split('.').reduce((value, key) => value?.[key], object)
  const metrics = paths.map(path => {
    const before = valueAt(baseline, path), after = valueAt(current, path)
    if (!Number.isFinite(before) || before <= 0 || !Number.isFinite(after) || after < 0) return { path, status: 'unavailable', reason: 'Missing, invalid or zero baseline metric.' }
    const changePercent = round((after / before - 1) * 100)
    return { path, before, after, changePercent, status: changePercent > thresholdPercent ? 'review-regression' : 'within-threshold' }
  })
  return { status: metrics.some(metric => metric.status === 'review-regression') ? 'review-regression' : metrics.some(metric => metric.status === 'unavailable') ? 'incomplete' : 'comparable', thresholdPercent, metrics, caveat: 'Same-machine repeated samples still include OS cache and load noise. Regression flags require review; they do not establish causation or promise speedups.' }
}

module.exports = { sha256, round, statistics, metadata, readBaseline, compareReports }
