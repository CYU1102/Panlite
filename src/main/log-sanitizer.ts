export const REDACTED = '[REDACTED]'

export interface SanitizeOptions {
  maxDepth?: number
  redactAllUrlQueryValues?: boolean
}

const DEFAULT_MAX_DEPTH = 12
const SENSITIVE_KEY_PATTERN = /^(?:cookie|setcookie|authorization|proxyauthorization|accesstoken|refreshtoken|idtoken|captchatoken|xcaptchatoken|securitytoken|xosssecuritytoken|sessiontoken|passcodetoken|sharetoken|token|apikey|clientsecret|accesskey|accesskeyid|accesskeysecret|password|passwd|pwd|passcode|sharepassword|extract(?:ion)?code|pick(?:up)?code|bduss|stoken|提取码|密码)$/i
const SENSITIVE_TEXT_KEY = '(?:x[_-]?captcha[_-]?token|captcha[_-]?token|x[_-]?oss[_-]?security[_-]?token|security[_-]?token|session[_-]?token|pass[_-]?code[_-]?token|share[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|access[_-]?key(?:[_-]?(?:id|secret))?|token|password|passwd|pwd|passcode|share[_-]?password|extract(?:ion)?[_-]?code|pick(?:up)?[_-]?code|bduss|stoken|提取码|密码)'
const SENSITIVE_HEADER_NAME = '(?:proxy-authorization|authorization|set-cookie|cookie|x-captcha-token|x-oss-security-token)'

function normalizeKey(key: PropertyKey): string {
  return String(key).replace(/[\s_\-.:]/g, '').toLowerCase()
}

export function isSensitiveLogKey(key: PropertyKey): boolean {
  return SENSITIVE_KEY_PATTERN.test(normalizeKey(key))
}

function sanitizeUrl(rawUrl: string, redactAllValues: boolean): string {
  let trailing = ''
  while (/[),.;!?]$/.test(rawUrl)) {
    trailing = rawUrl.slice(-1) + trailing
    rawUrl = rawUrl.slice(0, -1)
  }
  try {
    const url = new URL(rawUrl)
    if (url.username) url.username = REDACTED
    if (url.password) url.password = REDACTED
    for (const key of [...url.searchParams.keys()]) {
      if (redactAllValues || isSensitiveLogKey(key)) url.searchParams.set(key, REDACTED)
    }
    if (url.hash && /(?:token|password|pwd|code|提取码)/i.test(url.hash)) url.hash = `#${REDACTED}`
    return url.toString().replace(/%5BREDACTED%5D/g, REDACTED) + trailing
  } catch {
    return rawUrl + trailing
  }
}

export function sanitizeLogText(input: string, options: SanitizeOptions = {}): string {
  if (!input) return input
  const redactAllUrlQueryValues = options.redactAllUrlQueryValues ?? true
  const trimmed = input.trim()
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(sanitizeLogValue(JSON.parse(input), options))
    } catch {
      // Continue with tolerant text patterns for malformed JSON logs.
    }
  }

  const sensitiveHeader = new RegExp(`\\b(${SENSITIVE_HEADER_NAME})\\s*([:=])\\s*(?:Bearer\\s+|Basic\\s+|OSS\\s+)?(?:"[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi')
  let output = input.replace(sensitiveHeader, (_match, name: string, separator: string) => `${name}${separator} ${REDACTED}`)
  output = output.replace(/\b(set-cookie|cookie)\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\r\n]+)/gi, (_match, name: string, separator: string) => `${name}${separator} ${REDACTED}`)

  const quotedSecret = new RegExp(`(["']?${SENSITIVE_TEXT_KEY}["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, 'gi')
  output = output.replace(quotedSecret, (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`)
  const bareSecret = new RegExp(`(${SENSITIVE_TEXT_KEY}\\s*[:=]\\s*)(?!${REDACTED.replace(/[\[\]]/g, '\\$&')})([^\\s,;&#}]+)`, 'gi')
  output = output.replace(bareSecret, (_match, prefix: string) => `${prefix}${REDACTED}`)
  output = output.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrl(url, redactAllUrlQueryValues))
  return output
}

function cloneSanitizedError(error: Error, options: SanitizeOptions, seen: WeakMap<object, unknown>, depth: number): Error {
  const sanitized = new Error(sanitizeLogText(error.message, options))
  sanitized.name = sanitizeLogText(error.name, options)
  if (error.stack) sanitized.stack = sanitizeLogText(error.stack, options)
  seen.set(error, sanitized)
  const source = error as Error & { cause?: unknown; [key: string]: unknown }
  if ('cause' in source) Object.defineProperty(sanitized, 'cause', {
    value: sanitizeValue(source.cause, options, seen, depth + 1),
    enumerable: false,
    configurable: true,
  })
  for (const [key, value] of Object.entries(source)) {
    if (key === 'cause') continue
    Object.defineProperty(sanitized, key, {
      value: isSensitiveLogKey(key) ? REDACTED : sanitizeValue(value, options, seen, depth + 1),
      enumerable: true,
      configurable: true,
    })
  }
  return sanitized
}

function sanitizeValue(value: unknown, options: SanitizeOptions, seen: WeakMap<object, unknown>, depth: number): unknown {
  if (typeof value === 'string') return sanitizeLogText(value, options)
  if (value === null || typeof value !== 'object') return value
  if (depth > (options.maxDepth ?? DEFAULT_MAX_DEPTH)) return '[MAX_DEPTH]'
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`
  if (value instanceof URL) return sanitizeUrl(value.toString(), options.redactAllUrlQueryValues ?? true)
  if (value instanceof Date) return new Date(value)
  const existing = seen.get(value)
  if (existing) return '[CIRCULAR]'
  if (value instanceof Error) return cloneSanitizedError(value, options, seen, depth)

  if (Array.isArray(value)) {
    const output: unknown[] = []
    seen.set(value, output)
    for (const item of value) output.push(sanitizeValue(item, options, seen, depth + 1))
    return output
  }
  if (value instanceof Map) {
    const output = new Map<unknown, unknown>()
    seen.set(value, output)
    for (const [key, item] of value) output.set(key, isSensitiveLogKey(String(key)) ? REDACTED : sanitizeValue(item, options, seen, depth + 1))
    return output
  }
  if (value instanceof Set) {
    const output = new Set<unknown>()
    seen.set(value, output)
    for (const item of value) output.add(sanitizeValue(item, options, seen, depth + 1))
    return output
  }

  const output: Record<PropertyKey, unknown> = {}
  seen.set(value, output)
  for (const key of Reflect.ownKeys(value)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue
    output[key] = isSensitiveLogKey(key) ? REDACTED : sanitizeValue(Reflect.get(value, key), options, seen, depth + 1)
  }
  return output
}

export function sanitizeLogValue<T>(value: T, options: SanitizeOptions = {}): T {
  return sanitizeValue(value, options, new WeakMap(), 0) as T
}

export function sanitizeLogArguments(values: readonly unknown[], options: SanitizeOptions = {}): unknown[] {
  return values.map((value) => sanitizeLogValue(value, options))
}

export function createLogSanitizer(options: SanitizeOptions = {}): (message: unknown) => unknown {
  return (message: unknown) => {
    if (message && typeof message === 'object' && 'data' in message && Array.isArray((message as { data?: unknown }).data)) {
      return {
        ...(message as Record<string, unknown>),
        data: sanitizeLogArguments((message as { data: unknown[] }).data, options),
      }
    }
    return sanitizeLogValue(message, options)
  }
}
