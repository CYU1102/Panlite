import { describe, expect, it } from 'vitest'

const { statistics, compareReports } = require('../../scripts/benchmark-report.cjs')

const report = () => ({ schema: 1, benchmark: 'workflows', fixtureSha256: 'same-fixture', environment: { cpu: 'same-cpu', node: 'v24.20.0' }, retrieval: { p95Ms: 20 } })

describe('performance candidate comparison', () => {
  it('cannot claim a speedup without an earlier candidate', () => {
    expect(compareReports(report(), null, ['retrieval.p95Ms']).status).toBe('unavailable')
  })
  it.each([
    { environment: { cpu: 'different-cpu', node: 'v24.20.0' } },
    { environment: { cpu: 'same-cpu', node: 'v24.21.0' } },
    { fixtureSha256: 'different-rows-or-queries' },
    { schema: 2 },
    { benchmark: 'different-workload' },
  ])('rejects a non-comparable baseline %j', change => {
    expect(compareReports(report(), { ...report(), ...change }, ['retrieval.p95Ms']).status).toBe('incompatible')
  })
  it('reports duration growth beyond the review threshold', () => {
    const current = report()
    current.retrieval.p95Ms = 25
    const comparison = compareReports(current, report(), ['retrieval.p95Ms'])
    expect(comparison.status).toBe('review-regression')
    expect(comparison.metrics[0]).toMatchObject({ before: 20, after: 25, changePercent: 25 })
  })
  it('reports a smaller duration only for an identical fixture and machine', () => {
    const current = report()
    current.retrieval.p95Ms = 10
    expect(compareReports(current, report(), ['retrieval.p95Ms']).metrics[0]).toMatchObject({ changePercent: -50, status: 'within-threshold' })
  })
  it('does not accept a missing or zero baseline duration', () => {
    const baseline = report()
    baseline.retrieval.p95Ms = 0
    expect(compareReports(report(), baseline, ['retrieval.p95Ms']).status).toBe('incomplete')
    expect(compareReports(report(), report(), ['missing.value']).status).toBe('incomplete')
  })
  it('uses the nearest-rank percentile and rejects empty/nonfinite samples', () => {
    expect(statistics([5, 1, 4, 2, 3])).toEqual({ count: 5, p50Ms: 3, p95Ms: 5, maxMs: 5 })
    expect(() => statistics([])).toThrow()
    expect(() => statistics([NaN])).toThrow()
    expect(() => statistics([-1])).toThrow()
  })
})
