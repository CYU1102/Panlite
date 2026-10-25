import { createHash } from 'node:crypto'

const SAMPLE_BYTES = 64 * 1024
const MIN_FILE_BYTES = 1024 * 1024
const REQUEST_TIMEOUT_MS = 12_000

/**
 * Main-process test helper. The caller alone selects the authorized account/file.
 * This module does not open a DB, resolve credentials, list drives, or write files.
 * create() returns the ordinary preview DTO; request(url, init) can use Electron
 * net.fetch or the real FilePreviewService.handleRequest(new Request(url, init)).
 * Only sanitized transport evidence is returned. Never serialize caller closures.
 */
export async function runReadOnlyPreviewProbe({ expectedFileSize, create, request, cleanup }) {
  if (!Number.isSafeInteger(expectedFileSize) || expectedFileSize < MIN_FILE_BYTES) {
    throw new Error('Choose an existing file of at least 1 MiB for bounded partial-read verification')
  }
  const sessions = []
  const checks = []
  let consumedBytes = 0
  let sessionCount = 0
  const report = {
    scope: 'One caller-selected authorized existing file; HEAD and bounded byte ranges only',
    caveats: [
      'Active cancellation is a local client interruption, not proof of a real upstream network outage.',
      'Byte-range verification does not establish browser codec support or actual video playback.',
      'Repeated sample SHA-256 checks consistency only; no independent original-file checksum is available.',
      'Consumed bytes count application-delivered chunks, not TCP buffers or provider billing.',
    ],
    sampleBytes: SAMPLE_BYTES,
    expectedFileSize,
    allChecksPassed: false,
    checks,
  }
  const newSession = async () => {
    const dto = await create()
    if (!dto || dto.delivery !== 'stream' || !/^panlite-preview:\/\/session\/[0-9a-f-]{36}$/.test(dto.assetUrl || '')
      || dto.assetUrl !== `panlite-preview://session/${dto.sessionId}`) {
      if (dto?.sessionId) await cleanup(dto.sessionId)
      throw new Error('Expected an opaque streaming preview session')
    }
    sessions.push(dto.sessionId)
    sessionCount++
    return dto
  }
  const probe = async (dto, name, { method = 'GET', range, expectedStatus = 206, start, end, interrupt = false } = {}) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const began = Date.now()
    const evidence = { name, method, ...(range ? { range } : {}), passed: false, consumedBytes: 0 }
    let response
    let reader
    try {
      response = await request(dto.assetUrl, { method, ...(range ? { headers: { Range: range } } : {}), signal: controller.signal })
      evidence.status = response.status
      evidence.contentLength = response.headers.get('content-length')
      evidence.contentRange = response.headers.get('content-range')
      evidence.acceptRanges = response.headers.get('accept-ranges')
      evidence.privateHeadersAbsent = ['set-cookie', 'location', 'authorization', 'cookie'].every(header => !response.headers.has(header))
      if (response.status !== expectedStatus) {
        evidence.failure = response.status === 200 && range ? 'upstream-range-ignored-body-cancelled' : 'unexpected-status'
        return evidence
      }
      if (expectedStatus === 404 || expectedStatus === 416 || method === 'HEAD') {
        evidence.passed = evidence.privateHeadersAbsent
          && (expectedStatus !== 416 || evidence.contentRange === `bytes */${expectedFileSize}`)
          && (method !== 'HEAD' || expectedStatus !== 200 || (response.body === null && evidence.contentLength === String(expectedFileSize)))
        return evidence
      }
      if (evidence.contentRange !== `bytes ${start}-${end}/${expectedFileSize}`
        || (evidence.contentLength !== null && Number(evidence.contentLength) !== end - start + 1)) {
        evidence.failure = 'range-metadata-mismatch'
        return evidence
      }
      if (!response.body) { evidence.failure = 'missing-body'; return evidence }
      reader = response.body.getReader()
      const hash = createHash('sha256')
      while (true) {
        const part = await reader.read()
        if (part.done) break
        consumedBytes += part.value.byteLength
        evidence.consumedBytes += part.value.byteLength
        if (evidence.consumedBytes > end - start + 1) { evidence.failure = 'range-body-too-large'; return evidence }
        hash.update(part.value)
        if (interrupt) {
          controller.abort()
          await reader.cancel().catch(() => undefined)
          // Closing the service session must revoke the URL regardless of buffering.
          await cleanup(dto.sessionId)
          evidence.clientAborted = true
          evidence.closedSession = true
          evidence.partialBodyObserved = evidence.consumedBytes < end - start + 1
          evidence.passed = evidence.privateHeadersAbsent && evidence.partialBodyObserved
          return evidence
        }
      }
      evidence.sha256 = hash.digest('hex')
      evidence.passed = evidence.privateHeadersAbsent && evidence.consumedBytes === end - start + 1
      if (!evidence.passed) evidence.failure = 'incomplete-range-body'
      return evidence
    } catch {
      evidence.failure = controller.signal.aborted ? 'request-aborted-or-timed-out' : 'request-failed'
      return evidence
    } finally {
      controller.abort()
      if (reader) await reader.cancel().catch(() => undefined)
      else await response?.body?.cancel().catch(() => undefined)
      clearTimeout(timer)
      evidence.elapsedMs = Date.now() - began
      checks.push(evidence)
    }
  }
  try {
    const first = await newSession()
    await probe(first, 'head', { method: 'HEAD', expectedStatus: 200 })
    const leading = await probe(first, 'leading-range', { range: `bytes=0-${SAMPLE_BYTES - 1}`, start: 0, end: SAMPLE_BYTES - 1 })
    // Do not continue consuming a file if the provider ignores/changes its range.
    if (!leading.passed) { report.stopped = 'leading-range-unavailable'; return report }
    const middle = Math.floor((expectedFileSize - SAMPLE_BYTES) / 2)
    await probe(first, 'middle-range', { range: `bytes=${middle}-${middle + SAMPLE_BYTES - 1}`, start: middle, end: middle + SAMPLE_BYTES - 1 })
    await probe(first, 'suffix-range', { range: `bytes=-${SAMPLE_BYTES}`, start: expectedFileSize - SAMPLE_BYTES, end: expectedFileSize - 1 })
    await probe(first, 'unsatisfiable-range', { range: `bytes=${expectedFileSize}-`, expectedStatus: 416 })
    await probe(first, 'client-interruption', { range: `bytes=0-${4 * SAMPLE_BYTES - 1}`, start: 0, end: 4 * SAMPLE_BYTES - 1, interrupt: true })
    await cleanup(first.sessionId)
    await probe(first, 'closed-session', { method: 'HEAD', expectedStatus: 404 })
    const reopened = await newSession()
    const reread = await probe(reopened, 'reopened-leading-range', { range: `bytes=0-${SAMPLE_BYTES - 1}`, start: 0, end: SAMPLE_BYTES - 1 })
    report.reopenedWithNewSession = reopened.sessionId !== first.sessionId
    report.reopenedSampleMatches = Boolean(reread.passed && reread.sha256 === leading.sha256)
    report.allChecksPassed = checks.every(check => check.passed) && report.reopenedWithNewSession && report.reopenedSampleMatches
    return report
  } finally {
    report.consumedBytes = consumedBytes
    report.sessionCount = sessionCount
    report.finishedAt = new Date().toISOString()
    for (const sessionId of sessions) await cleanup(sessionId)
  }
}
