/** Stop waiting after cancellation, while safely observing any late result. */
export function waitForPreview<T>(operation: Promise<T>, signal?: AbortSignal, disposeLate?: (value: T) => void): Promise<T> {
  if (!signal) return operation
  return new Promise((resolve, reject) => {
    let finished = false
    const abort = () => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      reject(signal.reason ?? new Error('预览已取消'))
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => {
      if (finished) {
        try { disposeLate?.(value) } catch { /* Best-effort late cleanup. */ }
        return
      }
      finished = true
      signal.removeEventListener('abort', abort)
      resolve(value)
    }, error => {
      if (finished) return
      finished = true
      signal.removeEventListener('abort', abort)
      reject(error)
    })
  })
}
