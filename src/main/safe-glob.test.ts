import { describe, expect, it } from 'vitest'
import { compileSafeGlob } from './safe-glob'

function previous(rule: string, unicode: boolean): RegExp {
  let pattern = '^'
  for (let index = 0; index < rule.length; index++) {
    const character = rule[index]
    if (character === '*' && rule[index + 1] === '*') { index++; if (rule[index + 1] === '/') { index++; pattern += '(?:.*/)?' } else pattern += '.*' }
    else if (character === '*') pattern += '[^/]*'
    else if (character === '?') pattern += '[^/]'
    else pattern += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(pattern + '(?:/.*)?$', unicode ? 'u' : '')
}

describe('bounded exclusion glob matching', () => {
  it('preserves existing matching semantics for bounded rules and paths', () => {
    let seed = 0x61726368
    const random = (max: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed >>> 8) % max }
    const alphabet = ['a', 'b', '/', '*', '?', '.', '$', '[', ']', '\\', '中', '😀', '\n', '\r', '\u2028', '\ud800']
    const text = (length: number): string => Array.from({ length }, () => alphabet[random(alphabet.length)]).join('')
    for (const unicode of [false, true]) {
      for (let sample = 0; sample < 8000; sample++) {
        const rule = text(random(9)), candidate = text(random(10))
        expect(compileSafeGlob(rule, unicode).test(candidate), JSON.stringify({ rule, candidate, unicode })).toBe(previous(rule, unicode).test(candidate))
      }
    }
  })

  it('matches recursive rules and distinguishes Unicode code points from UTF-16 units', () => {
    expect(compileSafeGlob('**/*.txt', true).test('deep/folder/a.txt')).toBe(true)
    expect(compileSafeGlob('**/*.txt', true).test('a.txt')).toBe(true)
    expect(compileSafeGlob('docs', true).test('docs/a.txt')).toBe(true)
    expect(compileSafeGlob('?', true).test('😀')).toBe(true)
    expect(compileSafeGlob('?', false).test('😀')).toBe(false)
  })

  it('finishes pathological nonmatching rules without catastrophic backtracking', () => {
    const pattern = '*a'.repeat(12) + 'b'
    for (const unicode of [false, true]) expect(compileSafeGlob(pattern, unicode).test('a'.repeat(80))).toBe(false)
  })

  it('fails explicitly when matching would exceed the operation budget', () => {
    expect(compileSafeGlob('z'.repeat(512), true).test('a'.repeat(5000))).toBe(false)
    expect(() => compileSafeGlob('*a'.repeat(256) + 'b', true).test('a'.repeat(5000))).toThrow('排除规则与路径过长')
  })
})
