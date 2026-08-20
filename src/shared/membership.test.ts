import { describe, expect, it } from 'vitest'
import { normalizeMembership } from './membership'

describe('membership normalization', () => {
  it('recognizes an active string membership and seconds expiry', () => {
    const expiry = Math.floor(Date.now() / 1000) + 86_400
    const result = normalizeMembership({ data: { member_type: 'SUPER_VIP', member_end_time: expiry } }, '夸克')
    expect(result.known).toBe(true)
    expect(result.isVip).toBe(true)
    expect(result.status).toBe('active')
    expect(result.label).toBe('SUPER_VIP')
    expect(result.expiresAt).toBe(expiry * 1000)
  })

  it('recognizes a normal user', () => {
    const result = normalizeMembership({ vip_type: 0 }, '百度')
    expect(result.status).toBe('none')
    expect(result.label).toBe('普通用户')
  })

  it('does not present unavailable provider data as a normal user', () => {
    const result = normalizeMembership({}, '迅雷')
    expect(result.known).toBe(false)
    expect(result.status).toBe('unknown')
  })
})
