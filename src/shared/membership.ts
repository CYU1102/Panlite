export type MembershipStatus = 'active' | 'expired' | 'none' | 'unknown'

export interface MembershipInfo {
  known: boolean
  isVip: boolean
  status: MembershipStatus
  label: string
  expiresAt?: number
  fetchedAt: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function walkRecords(value: unknown, depth = 0, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (depth > 3) return output
  const record = asRecord(value)
  if (!record) return output
  output.push(record)
  for (const child of Object.values(record)) walkRecords(child, depth + 1, output)
  return output
}

function numericDate(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() && !/^\d+(\.\d+)?$/.test(value.trim())) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return undefined
  const milliseconds = number < 10_000_000_000 ? number * 1000 : number
  // Ignore obvious flags/counts accidentally found by the generic parser.
  if (milliseconds < Date.now() - 10 * 365 * 24 * 60 * 60 * 1000) return undefined
  return milliseconds
}

const TYPE_KEYS = ['vip_type', 'member_type', 'membership_type', 'level', 'vip_level', 'svip_level', 'is_vip', 'isVip', 'vip', 'svip']
const EXPIRY_KEYS = ['vip_end_time', 'svip_end_time', 'member_end_time', 'member_expire_time', 'membership_end_time', 'expire_time', 'expires_at', 'expired_at', 'expire_at', 'end_time', 'vip_expire_time', 'svip_expire_time', 'vip_expire', 'svip_expire', 'deadline']

/** Normalize the different membership shapes returned by cloud providers. */
export function normalizeMembership(raw: unknown, platformLabel: string): MembershipInfo {
  const records = walkRecords(raw)
  let typeValue: unknown
  let expiry: number | undefined
  for (const record of records) {
    if (typeValue === undefined) {
      for (const key of TYPE_KEYS) {
        if (record[key] !== undefined && record[key] !== null) {
          typeValue = record[key]
          break
        }
      }
    }
    if (!expiry) {
      for (const key of EXPIRY_KEYS) {
        const candidate = numericDate(record[key])
        if (candidate) {
          expiry = candidate
          break
        }
      }
    }
  }

  const typeText = typeof typeValue === 'string' ? typeValue.trim() : ''
  const typeNumber = typeof typeValue === 'boolean' ? (typeValue ? 1 : 0) : Number(typeValue)
  const known = typeValue !== undefined || expiry !== undefined
  const isVip = Boolean(
    (typeof typeValue === 'boolean' && typeValue)
    || (Number.isFinite(typeNumber) && typeNumber > 0)
    || /vip|svip|会员|超级|premium/i.test(typeText),
  )
  const status: MembershipStatus = !known
    ? 'unknown'
    : expiry && expiry <= Date.now()
      ? 'expired'
      : isVip ? 'active' : 'none'
  const label = !known
    ? `${platformLabel}会员未知`
    : isVip
      ? (typeText || `${platformLabel}会员`)
      : '普通用户'

  return { known, isVip, status, label, expiresAt: expiry, fetchedAt: Date.now() }
}
