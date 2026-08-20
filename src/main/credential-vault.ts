import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface CredentialEnvelopeV1 {
  version: 1
  algorithm: 'aes-256-gcm'
  encoding: 'utf8-json'
  keyId: string
  createdAt: string
  context: string
  nonce: string
  ciphertext: string
  authTag: string
}
export type CredentialEnvelope = CredentialEnvelopeV1
export type VaultSecret = string | number | boolean | null | Record<string, unknown> | unknown[]

export interface VaultSealOptions {
  keyId?: string
  context?: string
  now?: () => Date
}

interface VaultPayload {
  type: 'string' | 'json'
  value: VaultSecret
}

const KEY_LENGTH = 32
const NONCE_LENGTH = 12
const TAG_LENGTH = 16
const MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024

function copyKey(key: Uint8Array): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== KEY_LENGTH) {
    throw new Error('保险箱密钥必须是 32 字节')
  }
  return Buffer.from(key)
}

function buildAuthenticatedHeader(envelope: Pick<CredentialEnvelopeV1, 'version' | 'algorithm' | 'encoding' | 'keyId' | 'createdAt' | 'context'>): Buffer {
  return Buffer.from(JSON.stringify({
    version: envelope.version,
    algorithm: envelope.algorithm,
    encoding: envelope.encoding,
    keyId: envelope.keyId,
    createdAt: envelope.createdAt,
    context: envelope.context,
  }), 'utf8')
}

function validateEnvelope(envelope: CredentialEnvelope): CredentialEnvelopeV1 {
  if (
    !envelope ||
    envelope.version !== 1 ||
    envelope.algorithm !== 'aes-256-gcm' ||
    envelope.encoding !== 'utf8-json'
  ) {
    throw new Error('不支持的凭据保险箱 envelope 版本或算法')
  }
  if (!envelope.keyId || typeof envelope.keyId !== 'string' || envelope.keyId.length > 256) throw new Error('保险箱 keyId 无效')
  if (typeof envelope.context !== 'string' || envelope.context.length > 1024) throw new Error('保险箱 context 无效')
  if (!Number.isFinite(Date.parse(envelope.createdAt))) throw new Error('保险箱创建时间无效')
  const nonce = Buffer.from(envelope.nonce, 'base64url')
  const tag = Buffer.from(envelope.authTag, 'base64url')
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
  if (nonce.length !== NONCE_LENGTH || tag.length !== TAG_LENGTH || ciphertext.length > MAX_CIPHERTEXT_BYTES) {
    throw new Error('凭据保险箱 envelope 已损坏')
  }
  return structuredClone(envelope)
}

function encodePayload(secret: VaultSecret): Buffer {
  if (secret === undefined || typeof secret === 'bigint' || typeof secret === 'function' || typeof secret === 'symbol') {
    throw new Error('保险箱只支持可序列化的凭据')
  }
  const payload: VaultPayload = { type: typeof secret === 'string' ? 'string' : 'json', value: secret }
  const encoded = JSON.stringify(payload)
  if (encoded === undefined) throw new Error('保险箱只支持可序列化的凭据')
  return Buffer.from(encoded, 'utf8')
}

export function createVaultKey(): Buffer {
  return randomBytes(KEY_LENGTH)
}

export function sealCredential(secret: VaultSecret, key: Uint8Array, options: VaultSealOptions = {}): CredentialEnvelopeV1 {
  const keyCopy = copyKey(key)
  const plaintext = encodePayload(secret)
  const nonce = randomBytes(NONCE_LENGTH)
  const envelope: CredentialEnvelopeV1 = {
    version: 1,
    algorithm: 'aes-256-gcm',
    encoding: 'utf8-json',
    keyId: options.keyId ?? randomBytes(12).toString('base64url'),
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    context: options.context ?? 'panlite:credential',
    nonce: nonce.toString('base64url'),
    ciphertext: '',
    authTag: '',
  }
  const aad = buildAuthenticatedHeader(envelope)
  try {
    const cipher = createCipheriv('aes-256-gcm', keyCopy, nonce)
    cipher.setAAD(aad)
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
    envelope.ciphertext = ciphertext.toString('base64url')
    envelope.authTag = cipher.getAuthTag().toString('base64url')
    ciphertext.fill(0)
    return envelope
  } finally {
    keyCopy.fill(0)
    plaintext.fill(0)
    aad.fill(0)
    nonce.fill(0)
  }
}

export function openCredential<T extends VaultSecret = VaultSecret>(envelopeInput: CredentialEnvelope, key: Uint8Array, expectedContext?: string): T {
  const envelope = validateEnvelope(envelopeInput)
  if (expectedContext !== undefined && envelope.context !== expectedContext) throw new Error('凭据用途不匹配')
  const keyCopy = copyKey(key)
  const nonce = Buffer.from(envelope.nonce, 'base64url')
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64url')
  const authTag = Buffer.from(envelope.authTag, 'base64url')
  const aad = buildAuthenticatedHeader(envelope)
  let plaintext: Buffer | null = null
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyCopy, nonce)
    decipher.setAAD(aad)
    decipher.setAuthTag(authTag)
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    const parsed = JSON.parse(plaintext.toString('utf8')) as VaultPayload
    if (!parsed || (parsed.type !== 'string' && parsed.type !== 'json') || !Object.prototype.hasOwnProperty.call(parsed, 'value')) {
      throw new Error('凭据载荷格式无效')
    }
    return parsed.value as T
  } catch (error) {
    if (error instanceof Error && (error.message === '凭据载荷格式无效' || error instanceof SyntaxError)) {
      throw new Error('凭据载荷格式无效')
    }
    throw new Error('凭据无法解密：密钥错误或数据已被篡改')
  } finally {
    keyCopy.fill(0)
    nonce.fill(0)
    ciphertext.fill(0)
    authTag.fill(0)
    aad.fill(0)
    plaintext?.fill(0)
  }
}

export function rotateCredential(
  envelope: CredentialEnvelope,
  oldKey: Uint8Array,
  newKey: Uint8Array,
  options: VaultSealOptions = {},
): CredentialEnvelopeV1 {
  const secret = openCredential(envelope, oldKey, envelope.context)
  return sealCredential(secret, newKey, {
    context: envelope.context,
    ...options,
  })
}

export function serializeEnvelope(envelope: CredentialEnvelope): string {
  return JSON.stringify(validateEnvelope(envelope))
}

export function parseEnvelope(serialized: string): CredentialEnvelopeV1 {
  if (typeof serialized !== 'string' || serialized.length > MAX_CIPHERTEXT_BYTES * 2) throw new Error('凭据保险箱 envelope 无效')
  try {
    return validateEnvelope(JSON.parse(serialized) as CredentialEnvelope)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('不支持')) throw error
    throw new Error('凭据保险箱 envelope 无效')
  }
}
