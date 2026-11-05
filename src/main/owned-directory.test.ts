import { describe, expect, it } from 'vitest'
import { sameDirectoryIdentity } from './owned-directory'

describe('owned directory identity', () => {
  it('distinguishes file identifiers that round to the same JavaScript number', () => {
    const first = 9_007_199_254_740_992n, second = first + 1n
    expect(Number(first)).toBe(Number(second))
    expect(sameDirectoryIdentity({ dev: 1n, ino: first }, { dev: 1n, ino: second })).toBe(false)
    expect(sameDirectoryIdentity({ dev: 1n, ino: first }, { dev: 1n, ino: first })).toBe(true)
    expect(sameDirectoryIdentity({ dev: 1n, ino: first }, { dev: 2n, ino: first })).toBe(false)
  })

  it('does not treat an unavailable inode as proof of ownership', () => {
    expect(sameDirectoryIdentity({ dev: 1n, ino: 0n }, { dev: 1n, ino: 0n })).toBe(false)
  })
})
