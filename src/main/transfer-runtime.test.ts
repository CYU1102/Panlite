import { describe, expect, it } from 'vitest'
import { RateLimiter } from './chunked-download'
import { isInTransferWindow } from './transfer-runtime'
import { splitRanges } from './chunked-download'

describe('splitRanges', () => {
  it('splits a large file into up to 8 contiguous ranges', () => {
    const size = 100 * 1024 * 1024
    const ranges = splitRanges(size, 4)
    expect(ranges).toHaveLength(4)
    expect(ranges[0]).toEqual({ start: 0, end: 25 * 1024 * 1024 - 1 })
    expect(ranges[3].end).toBe(size - 1)
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index].start).toBe(ranges[index - 1].end + 1)
    }
  })

  it('never returns chunks smaller than the minimum size', () => {
    const ranges = splitRanges(10 * 1024 * 1024, 8)
    expect(ranges).toHaveLength(1)
    expect(splitRanges(0, 4)).toEqual([{ start: 0, end: 0 }])
  })

  it('distributes remainder bytes without gaps', () => {
    const ranges = splitRanges(33, 8)
    let covered = 0
    for (const range of ranges) {
      expect(range.start).toBe(covered)
      covered = range.end + 1
    }
    expect(covered).toBe(33)
  })
})

describe('RateLimiter', () => {
  it('passes through when unlimited', async () => {
    const limiter = new RateLimiter(0)
    const startedAt = Date.now()
    await limiter.take(10 * 1024 * 1024)
    expect(Date.now() - startedAt).toBeLessThan(100)
  })

  it('throttles when a small limit is configured', async () => {
    const limiter = new RateLimiter(64 * 1024)
    const startedAt = Date.now()
    await limiter.take(192 * 1024)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1000)
  })
})

describe('isInTransferWindow', () => {
  const at = (hours: number, minutes: number): Date => new Date(2026, 7, 28, hours, minutes)

  it('returns true when no window is configured', () => {
    expect(isInTransferWindow('', at(12, 0))).toBe(true)
    expect(isInTransferWindow('bad-input', at(12, 0))).toBe(true)
  })

  it('handles normal and cross-midnight windows', () => {
    expect(isInTransferWindow('02:00-08:00', at(3, 0))).toBe(true)
    expect(isInTransferWindow('02:00-08:00', at(9, 0))).toBe(false)
    expect(isInTransferWindow('22:00-06:00', at(23, 30))).toBe(true)
    expect(isInTransferWindow('22:00-06:00', at(5, 59))).toBe(true)
    expect(isInTransferWindow('22:00-06:00', at(12, 0))).toBe(false)
  })
})
