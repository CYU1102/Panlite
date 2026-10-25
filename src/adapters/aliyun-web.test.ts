import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1'
import type { DriveAccount } from '../shared/types'
import { createSessionKeys, ecdsaSignSha256, aliyunWebAdapter, setAliyunWebCredentialRefreshHandler } from './aliyun-web'

const electron = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('electron', () => ({ net: { fetch: electron.fetch } }))
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

/** 把 r||s（各 32 字节）编码回 DER ECDSA 签名，便于用 node crypto 验证 */
function derFromRawSignature(rawHex: string): Buffer {
  rawHex = rawHex.slice(0, 128)
  const half = rawHex.length / 2
  const padDer = (valueHex: string): Buffer => {
    const encoded = Buffer.from(valueHex, 'hex')
    // DER INTEGERs must be minimally encoded. Raw P1363 values are fixed at
    // 32 bytes and can start with one or more zero bytes; retaining those
    // makes OpenSSL reject an otherwise valid signature intermittently.
    let firstNonZero = 0
    while (firstNonZero < encoded.length - 1 && encoded[firstNonZero] === 0) firstNonZero++
    const value = encoded.subarray(firstNonZero)
    const padded = value[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), value]) : value
    return Buffer.concat([Buffer.from([0x02, padded.length]), padded])
  }
  const r = padDer(rawHex.slice(0, half))
  const s = padDer(rawHex.slice(half))
  const body = Buffer.concat([r, s])
  return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

function assertSignatureVerified(signature: string, message: string, publicKeyHex: string): void {
  const hash = crypto.createHash('sha256').update(message).digest()
  const compact = Buffer.from(signature.slice(0, 128), 'hex')
  const publicKeyBytes = Buffer.from(publicKeyHex, 'hex')
  expect(secp256k1.verify(compact, hash, publicKeyBytes, { lowS: true, prehash: false })).toBe(true)
  expect(secp256k1.verify(compact, crypto.createHash('sha256').update(`${message}!`).digest(), publicKeyBytes)).toBe(false)
  // Retain an independent OpenSSL verifier in Node. Electron's BoringSSL
  // cannot import this curve, so recovery and fixed vectors run there instead.
  if (crypto.getCurves().includes('secp256k1')) {
    const point = secp256k1.ProjectivePoint.fromHex(publicKeyHex).toHex(false)
    const publicKey = crypto.createPublicKey({ format: 'der', type: 'spki', key: Buffer.from(
      `3056301006072a8648ce3d020106052b8104000a034200${point}`, 'hex',
    ) })
    expect(crypto.verify('sha256', Buffer.from(message), publicKey, derFromRawSignature(signature))).toBe(true)
  }
}

describe('aliyun web signature', () => {
  it('creates independent scalar keys without native EC key generation or JWK imports', () => {
    const nativeGeneration = vi.spyOn(crypto, 'generateKeyPairSync').mockImplementation(() => { throw new Error('UNKNOWN_GROUP') })
    const nativeImport = vi.spyOn(crypto, 'createPrivateKey').mockImplementation(() => { throw new Error('UNKNOWN_GROUP') })
    const first = createSessionKeys()
    const second = createSessionKeys()
    expect(first.privateKey.type).toBe('secret')
    expect(first.privateKey.symmetricKeySize).toBe(32)
    expect(first.publicKeyHex).not.toBe(second.publicKeyHex)
    const signature = ecdsaSignSha256(first.privateKey, 'portable-key')
    expect(recoverPublicKey(signature, 'portable-key', true)).toBe(first.publicKeyHex)
    expect(nativeGeneration).not.toHaveBeenCalled()
    expect(nativeImport).not.toHaveBeenCalled()
  })

  it('produces a verifiable lower-S secp256k1 ECDSA signature', () => {
    const { privateKey, publicKeyHex } = createSessionKeys()
    const data = '5dde4e1bdf9e4966b387ba58f4b3fdc3:device123:user456:0'
    const signatureHex = ecdsaSignSha256(privateKey, data)

    expect(signatureHex).toMatch(/^[0-9a-f]{128}0[0-3]$/)

    // lower-S：s 部分必须小于曲线阶的一半
    const halfN = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0')
    const s = BigInt('0x' + signatureHex.slice(64, 128))
    expect(s).toBeLessThanOrEqual(halfN)

    assertSignatureVerified(signatureHex, data, publicKeyHex)

    // 公钥为压缩形式（02/03 前缀 + x 坐标）
    expect(publicKeyHex).toMatch(/^0[23][0-9a-f]{64}$/)
    expect(recoverPublicKey(signatureHex, data, true)).toBe(publicKeyHex)
  })

  it('verifies against the exported public key across different messages', () => {
    const { privateKey, publicKeyHex } = createSessionKeys()
    for (const message of ['a:b:c:0', 'another-session-data', '阿里云盘签名测试']) {
      const raw = ecdsaSignSha256(privateKey, message)
      assertSignatureVerified(raw, message, publicKeyHex)
    }
  })

  it('recovers a fixed public key for both recovery bits, including lower-S normalization', () => {
    // SEC2 secp256k1 generator: private scalar 1, independently fixed x/y.
    const x = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    const y = '483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8'
    const privateKey = crypto.createSecretKey(Buffer.from('1'.padStart(64, '0'), 'hex'))
    const vectors = [
      ['session-0', '2cd1246efd760f25bff09f811553cdcb7aadbddd96e1752db3e201499e83676e1febd0c0edb499180281bd0464d1411d3e014f4824a64ffc4fc3c6d3409f37bc00'],
      ['session-2', '7cc163e9283b3ed976bca6efa8110576dd2f2634db4d2fd336a5a9c11e88743e45bf29440c3f809685dc0933998f03cf4bf5a1cff242ea9807e3d5f5454df55801'],
      ['session-3', '1a173496501be6dba4b7f108bcb0dd2e4297af703349df7d4f5e6337c97d883a3c1e758db6594b342ec3879982f99cb4138c77dd2152085a329864af956a8dc301'],
    ]
    for (const [message, expectedSignature] of vectors) {
      const signature = ecdsaSignSha256(privateKey, message)
      expect(signature).toBe(expectedSignature)
      expect(recoverPublicKey(signature, message)).toBe(`04${x}${y}`)
      assertSignatureVerified(signature, message, `04${x}${y}`)
      const wrongRecovery = (parseInt(signature.slice(128), 16) ^ 1).toString(16).padStart(2, '0')
      expect(recoverPublicKey(signature.slice(0, 128) + wrongRecovery, message)).not.toBe(`04${x}${y}`)
    }
    // This deterministic case starts high-S with recid 0. Normalizing S must
    // also flip recid to 1; verifying only r/s would miss the previous bug.
    const unnormalized = secp256k1.sign(crypto.createHash('sha256').update('session-3').digest(), '1'.padStart(64, '0'), { lowS: false })
    expect(unnormalized.hasHighS()).toBe(true)
    expect(unnormalized.recovery).toBe(0)
  })
})

function recoverPublicKey(signature: string, message: string, compressed = false): string {
  return secp256k1.Signature.fromCompact(signature.slice(0, 128))
    .addRecoveryBit(parseInt(signature.slice(128), 16))
    .recoverPublicKey(crypto.createHash('sha256').update(message).digest())
    .toHex(compressed)
}

interface RequestRecord { url: string; method?: string; headers: Headers; body: Record<string, unknown> }
const requests: RequestRecord[] = []
const replies: Array<{ body: unknown; status: number }> = []
const persisted = vi.fn()
let sequence = 0

function account(credential: DriveAccount['credential'] = { refreshToken: 'refresh-fixture' }): DriveAccount {
  return { id: `aliyun-web-${++sequence}`, platform: 'aliyun_web', loginType: 'token', nickname: 'fixture', credential, status: 'active', createdAt: 0, updatedAt: 0 }
}

function readyAccount(): DriveAccount {
  return account({ refreshToken: 'refresh-fixture', accessToken: 'access-fixture', userId: 'drive|device|user', expiresAt: Date.now() + 3_600_000 })
}

function reply(body: unknown, status = 200): void { replies.push({ body, status }) }

function refreshReply(suffix = ''): void {
  reply({ access_token: `access-new${suffix}`, refresh_token: `refresh-new${suffix}`, device_id: `device${suffix}`, user_id: `user${suffix}`, default_drive_id: 'drive', expires_in: 3600 })
}

function recordRequest(url: string, options: RequestInit): RequestRecord {
  const recorded = { url, method: options.method, headers: new Headers(options.headers), body: JSON.parse(String(options.body || '{}')) as Record<string, unknown> }
  requests.push(recorded)
  return recorded
}

beforeEach(() => {
  requests.length = 0
  replies.length = 0
  persisted.mockReset()
  setAliyunWebCredentialRefreshHandler(persisted)
  electron.fetch.mockImplementation(async (url: string, options: RequestInit) => {
    recordRequest(url, options)
    const next = replies.shift()
    if (!next) throw new Error(`Missing HTTP fixture: ${url}`)
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status })
  })
})

afterEach(() => {
  expect(replies).toHaveLength(0)
  vi.restoreAllMocks()
})

function assertRegisteredSignature(request: RequestRecord, userId: string): void {
  const signature = request.headers.get('x-signature')!
  const deviceId = request.headers.get('x-device-id')!
  const message = `5dde4e1bdf9e4966b387ba58f4b3fdc3:${deviceId}:${userId}:0`
  expect(request.body.nonce).toBe(0)
  expect(signature).toMatch(/^[0-9a-f]{128}0[0-3]$/)
  expect(recoverPublicKey(signature, message)).toBe(request.body.pubKey)
}

describe('aliyun web HTTP device sessions', () => {
  it('bootstraps user identity and creates a persistent device ID when refresh omits metadata', async () => {
    const current = account()
    reply({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 })
    reply({ user_id: 'bootstrap-user', default_drive_id: 'bootstrap-drive' })
    reply({ result: true }); reply({ nick_name: 'bootstrapped' })
    await expect(aliyunWebAdapter.getUserInfo(current)).resolves.toMatchObject({ nickname: 'bootstrapped' })
    expect(requests.map(r => new URL(r.url).pathname)).toEqual(['/v2/account/token', '/v2/user/get', '/users/v1/users/device/create_session', '/v2/user/get'])
    expect(requests[1].headers.has('x-signature')).toBe(false)
    assertRegisteredSignature(requests[2], 'bootstrap-user')
    const deviceId = requests[2].headers.get('x-device-id')!
    expect(deviceId).toMatch(/^[0-9a-f]{64}$/)
    expect(current.credential.userId).toBe(`bootstrap-drive|${deviceId}|bootstrap-user`)
    reply({ nick_name: 'cached' })
    await aliyunWebAdapter.getUserInfo(structuredClone(current))
    expect(requests).toHaveLength(5)
  })

  it('rejects missing user identity before registering or issuing file operations', async () => {
    reply({ access_token: 'access-new', expires_in: 3600 })
    reply({ default_drive_id: 'drive-only' })
    await expect(aliyunWebAdapter.listFiles(account(), '0')).rejects.toThrow('无法获取签名会话的 user_id')
    expect(requests).toHaveLength(2)
  })

  it('refreshes expired tokens during identity bootstrap with a bounded retry', async () => {
    reply({ access_token: 'initial-access' }); reply({ code: 'AccessTokenInvalid' }, 401)
    refreshReply(); reply({ result: true }); reply({ nick_name: 'after-bootstrap' })
    await expect(aliyunWebAdapter.getUserInfo(account())).resolves.toMatchObject({ nickname: 'after-bootstrap' })
    expect(requests).toHaveLength(5)
    assertRegisteredSignature(requests[3], 'user')
  })

  it('refreshes, persists identity, registers a recoverable key and reuses the session across DB snapshots', async () => {
    const current = account()
    refreshReply()
    reply({ result: true })
    reply({ nick_name: 'example' })
    await expect(aliyunWebAdapter.getUserInfo(current)).resolves.toMatchObject({ nickname: 'example' })
    expect(persisted).toHaveBeenCalledWith(current.id, expect.objectContaining({ accessToken: 'access-new', refreshToken: 'refresh-new', userId: 'drive|device|user' }))
    expect(requests.map(r => new URL(r.url).pathname)).toEqual(['/v2/account/token', '/users/v1/users/device/create_session', '/v2/user/get'])
    assertRegisteredSignature(requests[1], 'user')
    expect(requests[1].body.refreshToken).toBe('refresh-new')
    expect(requests[2].headers.get('x-signature')).toBe(requests[1].headers.get('x-signature'))
    reply({ items: [{ file_id: 'file-1', name: 'report', type: 'file' }] })
    await expect(aliyunWebAdapter.listFiles(structuredClone(current), '0')).resolves.toMatchObject({ files: [{ id: 'file-1' }] })
    expect(requests.filter(r => r.url.endsWith('/device/create_session'))).toHaveLength(1)
  })

  it('coalesces concurrent initialization for separate account objects', async () => {
    const current = account()
    electron.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      recordRequest(url, options)
      if (url.endsWith('/account/token')) return Response.json({ access_token: 'access-new', refresh_token: 'refresh-new', device_id: 'device', user_id: 'user', expires_in: 3600 })
      if (url.endsWith('/device/create_session')) return Response.json({ result: true })
      return Response.json({ nick_name: 'example' })
    })
    await Promise.all([aliyunWebAdapter.getUserInfo(current), aliyunWebAdapter.getUserInfo(structuredClone(current))])
    expect(requests.filter(r => r.url.endsWith('/account/token'))).toHaveLength(1)
    expect(requests.filter(r => r.url.endsWith('/device/create_session'))).toHaveLength(1)
    expect(persisted).toHaveBeenCalledTimes(1)
  })

  it('refreshes an expired cached token before a later call', async () => {
    const current = readyAccount()
    const started = Date.now()
    reply({ result: true }); reply({ nick_name: 'before' })
    await aliyunWebAdapter.getUserInfo(current)
    vi.spyOn(Date, 'now').mockReturnValue(started + 3_600_000)
    refreshReply('-renewed'); reply({ result: true }); reply({ nick_name: 'after' })
    await expect(aliyunWebAdapter.getUserInfo(current)).resolves.toMatchObject({ nickname: 'after' })
    assertRegisteredSignature(requests[3], 'user-renewed')
    expect(requests[4].headers.get('authorization')).toBe('Bearer access-new-renewed')
  })

  it('refreshes and re-registers after an HTTP 401 with a non-JSON body', async () => {
    const current = readyAccount()
    reply({ result: true }); reply('<html>expired</html>', 401)
    refreshReply('-rotated'); reply({ result: true }); reply({ nick_name: 'after-refresh' })
    await expect(aliyunWebAdapter.getUserInfo(current)).resolves.toMatchObject({ nickname: 'after-refresh' })
    assertRegisteredSignature(requests[3], 'user-rotated')
    expect(requests[4].headers.get('x-device-id')).toBe('device-rotated')
    expect(current.credential.refreshToken).toBe('refresh-new-rotated')
  })

  it('repairs device invalidation once for concurrent requests without refreshing tokens', async () => {
    const current = readyAccount()
    reply({ result: true }); reply({ nick_name: 'initial' })
    await aliyunWebAdapter.getUserInfo(current)
    let calls = 0
    electron.fetch.mockImplementation(async (url: string, options: RequestInit) => {
      recordRequest(url, options)
      if (url.endsWith('/device/create_session')) return Response.json({ result: true })
      return calls++ < 2 ? Response.json({ code: 'DeviceSessionSignatureInvalid' }, { status: 400 }) : Response.json({ nick_name: 'repaired' })
    })
    const result = await Promise.all([aliyunWebAdapter.getUserInfo(current), aliyunWebAdapter.getUserInfo(structuredClone(current))])
    expect(result.map(r => r.nickname)).toEqual(['repaired', 'repaired'])
    expect(requests.filter(r => r.url.endsWith('/device/create_session'))).toHaveLength(2)
    expect(requests.filter(r => r.url.endsWith('/account/token'))).toHaveLength(0)
  })

  it('retries token expiry during device registration before the business request', async () => {
    const current = readyAccount()
    reply({ code: 'AccessTokenInvalid' }, 401)
    refreshReply(); reply({ result: true }); reply({ nick_name: 'ready' })
    await expect(aliyunWebAdapter.getUserInfo(current)).resolves.toMatchObject({ nickname: 'ready' })
    expect(requests).toHaveLength(4)
    assertRegisteredSignature(requests[2], 'user')
  })

  it.each([{}, { result: false }, { success: false }, { code: 'Denied' }, [], null, '<html>not JSON</html>'])('rejects invalid session registration %j without caching a signature', async (body) => {
    const current = readyAccount()
    reply(body)
    await expect(aliyunWebAdapter.getUserInfo(current)).rejects.toThrow('签名会话创建失败')
    expect(requests).toHaveLength(1)
    reply({ result: true }); reply({ nick_name: 'retry' })
    await expect(aliyunWebAdapter.getUserInfo(current)).resolves.toMatchObject({ nickname: 'retry' })
    expect(requests.filter(r => r.url.endsWith('/device/create_session'))).toHaveLength(2)
  })

  it('does not register a device or persist credentials from an invalid refresh response', async () => {
    const current = account()
    reply({ access_token: { invalid: true } })
    await expect(aliyunWebAdapter.getUserInfo(current)).rejects.toThrow('授权已失效')
    expect(requests).toHaveLength(1)
    expect(persisted).not.toHaveBeenCalled()
  })

  it('does not silently turn non-JSON business responses into successful empty data', async () => {
    reply({ result: true }); reply('<html>unavailable</html>')
    await expect(aliyunWebAdapter.getUserInfo(readyAccount())).rejects.toThrow('无效 JSON')
  })

  it('bounds repeated signature repairs before making any extra registration call', async () => {
    reply({ result: true }); reply({ code: 'DeviceSessionSignatureInvalid' }, 400)
    reply({ result: true }); reply({ code: 'DeviceSessionSignatureInvalid' }, 400)
    reply({ result: true }); reply({ code: 'DeviceSessionSignatureInvalid' }, 400)
    await expect(aliyunWebAdapter.getUserInfo(readyAccount())).rejects.toThrow('重试次数超限')
    expect(requests).toHaveLength(6)
  })

  it('starts a fresh session when the user replaces credentials', async () => {
    const current = readyAccount()
    reply({ result: true }); reply({ nick_name: 'before' })
    await aliyunWebAdapter.getUserInfo(current)
    current.credential = { refreshToken: 'manually-replaced-refresh' }
    refreshReply('-replacement'); reply({ result: true }); reply({ nick_name: 'after' })
    await expect(aliyunWebAdapter.getUserInfo(current)).resolves.toMatchObject({ nickname: 'after' })
    expect(requests[2].body.refresh_token).toBe('manually-replaced-refresh')
    expect(requests[3].body.pubKey).not.toBe(requests[0].body.pubKey)
  })
})

describe('aliyun web parseShareLink', () => {
  const adapter = aliyunWebAdapter
  it('parses alipan/aliyundrive share urls with passwords', async () => {
    await expect(adapter.parseShareLink!('https://www.alipan.com/s/abc123?pwd=ab12')).resolves.toEqual({
      shareId: 'abc123', password: 'ab12',
    })
    await expect(adapter.parseShareLink!('https://www.aliyundrive.com/s/xyz789', 'zz99')).resolves.toEqual({
      shareId: 'xyz789', password: 'zz99',
    })
    await expect(adapter.parseShareLink!('https://pan.quark.cn/s/notmine')).rejects.toThrow('无法解析')
  })
})
