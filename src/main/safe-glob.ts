/** A bounded NFA for the existing exclusion-rule wildcard syntax. */
type Token = { kind: 'literal'; value: string } | { kind: 'one' | 'star' | 'globstar' | 'dir-start' | 'dir-scan' | 'suffix-start' | 'suffix-scan' }

const dotMatches = (value: string): boolean => value !== '\n' && value !== '\r' && value !== '\u2028' && value !== '\u2029'
const MAX_MATCH_STEPS = 2_000_000
export class SafeGlobLimitError extends Error {
  constructor() { super('排除规则与路径过长，无法安全匹配，请简化规则'); this.name = 'SafeGlobLimitError' }
}

export function compileSafeGlob(rule: string, unicode: boolean): { test(value: string): boolean } {
  if (!rule.includes('*') && !rule.includes('?')) return { test(value: string): boolean {
    if (value === rule) return true
    if (!value.startsWith(`${rule}/`)) return false
    // The old optional descendant suffix used dot without dotAll.
    return !/[\n\r\u2028\u2029]/u.test(value.slice(rule.length + 1))
  } }
  const recursiveSuffix = rule.startsWith('**/*') ? rule.slice(4) : ''
  if (recursiveSuffix && /^[A-Za-z0-9._-]+$/u.test(recursiveSuffix)) return { test(value: string): boolean {
    const parts = value.split('/')
    let lineBreakPart = -1
    for (let index = 0; index < parts.length; index++) {
      if (!/[\n\r\u2028\u2029]/u.test(parts[index])) continue
      if (lineBreakPart !== -1) return false
      lineBreakPart = index
    }
    return parts.some((part, index) => part.endsWith(recursiveSuffix) && (lineBreakPart === -1 || lineBreakPart === index))
  } }
  // The transfer matcher historically used the RegExp u flag; the backup
  // matcher did not, so ? consumes a code point or UTF-16 unit respectively.
  const characters = unicode ? Array.from(rule) : rule.split('')
  const tokens: Token[] = []
  for (let index = 0; index < characters.length; index++) {
    const current = characters[index]
    if (current === '*' && characters[index + 1] === '*') {
      index++
      if (characters[index + 1] === '/') { index++; tokens.push({ kind: 'dir-start' }, { kind: 'dir-scan' }) }
      else tokens.push({ kind: 'globstar' })
    } else if (current === '*') tokens.push({ kind: 'star' })
    else if (current === '?') tokens.push({ kind: 'one' })
    else tokens.push({ kind: 'literal', value: current })
  }
  // Preserve the original optional /descendant suffix.
  tokens.push({ kind: 'suffix-start' }, { kind: 'suffix-scan' })

  function close(states: Uint8Array): void {
    for (let index = 0; index < tokens.length; index++) {
      if (!states[index]) continue
      const kind = tokens[index].kind
      if (kind === 'star' || kind === 'globstar' || kind === 'suffix-scan') states[index + 1] = 1
      else if (kind === 'dir-start') { states[index + 1] = 1; states[index + 2] = 1 }
      else if (kind === 'suffix-start') states[index + 2] = 1
    }
  }

  return { test(value: string): boolean {
    const input = unicode ? Array.from(value) : value.split('')
    let active = new Uint8Array(tokens.length + 1)
    let next = new Uint8Array(tokens.length + 1)
    let steps = 0
    active[0] = 1
    for (const character of input) {
      steps += tokens.length
      if (steps > MAX_MATCH_STEPS) throw new SafeGlobLimitError()
      close(active)
      next.fill(0)
      for (let index = 0; index < tokens.length; index++) {
        if (!active[index]) continue
        const token = tokens[index]
        if (token.kind === 'literal') { if (character === token.value) next[index + 1] = 1 }
        else if (token.kind === 'one') { if (character !== '/') next[index + 1] = 1 }
        else if (token.kind === 'star') { if (character !== '/') next[index] = 1 }
        else if (token.kind === 'globstar') { if (dotMatches(character)) next[index] = 1 }
        else if (token.kind === 'dir-scan') {
          if (dotMatches(character)) next[index] = 1
          if (character === '/') next[index + 1] = 1
        } else if (token.kind === 'suffix-start') { if (character === '/') next[index + 1] = 1 }
        else if (token.kind === 'suffix-scan') { if (dotMatches(character)) next[index] = 1 }
      }
      if (!next.includes(1)) return false
      const previous = active
      active = next
      next = previous
    }
    close(active)
    return active[tokens.length] === 1
  } }
}
