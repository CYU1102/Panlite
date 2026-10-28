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
  it('checks the unrounded change at the review threshold', () => {
    const current = report()
    current.retrieval.p95Ms = 24.0004
    const comparison = compareReports(current, report(), ['retrieval.p95Ms'])
    expect(comparison.status).toBe('review-regression')
    expect(comparison.metrics[0].changePercent).toBe(20)
    expect(comparison.metrics[0].changePercentExact).toBeGreaterThan(20)
    current.retrieval.p95Ms = 24
    expect(compareReports(current, report(), ['retrieval.p95Ms']).status).toBe('comparable')
    const baseline = report()
    baseline.retrieval.p95Ms = 100
    current.retrieval.p95Ms = 110
    expect(compareReports(current, baseline, ['retrieval.p95Ms'], 10).status).toBe('comparable')
    current.retrieval.p95Ms = 110.0001
    expect(compareReports(current, baseline, ['retrieval.p95Ms'], 10).status).toBe('review-regression')
  })
  it('does not compare failed runs or missing configuration and metrics', () => {
    expect(compareReports({ ...report(), completed: false }, report(), ['retrieval.p95Ms']).status).toBe('incomplete')
    expect(compareReports(report(), { ...report(), completed: false }, ['retrieval.p95Ms']).status).toBe('incomplete')
    expect(compareReports({ ...report(), environment: undefined }, { ...report(), environment: undefined }, ['retrieval.p95Ms']).status).toBe('incompatible')
    expect(compareReports({ ...report(), benchmark: undefined }, { ...report(), benchmark: undefined }, ['retrieval.p95Ms']).status).toBe('incompatible')
    expect(compareReports(report(), report(), []).status).toBe('incomplete')
    expect(() => compareReports(report(), report(), ['retrieval.p95Ms'], NaN)).toThrow()
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
