import { formatDuration } from './progress.js'
import { normalizeBaseUrl } from './url.js'

const MAX_RETRIES = 3
const UNLIMITED_RATE_LIMIT_RETRIES = Number.POSITIVE_INFINITY

export class BytifiApiError extends Error {
  constructor(message, { status = 0, body = null, retryAfterMs = null } = {}) {
    super(message)
    this.name = 'BytifiApiError'
    this.status = status
    this.body = body
    this.retryAfterMs = retryAfterMs
  }
}

export class BytifiNetworkError extends Error {
  constructor(message, { cause } = {}) {
    super(message)
    this.name = 'BytifiNetworkError'
    this.cause = cause
  }
}

export { normalizeBaseUrl } from './url.js'

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function parseRetryAfterMs(response) {
  const retryAfter = response.headers.get('Retry-After')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000
    }

    const dateMs = Date.parse(retryAfter)
    if (Number.isFinite(dateMs)) {
      return Math.max(0, dateMs - Date.now())
    }
  }

  const resetHeader = response.headers.get('RateLimit-Reset')
  if (resetHeader) {
    const resetValue = Number(resetHeader)
    if (Number.isFinite(resetValue)) {
      if (resetValue > 1_000_000_000) {
        return Math.max(0, resetValue * 1000 - Date.now())
      }
      return Math.max(0, resetValue * 1000)
    }
  }

  return null
}

export function isRetryableError(error) {
  if (error instanceof BytifiNetworkError) return true
  if (error instanceof BytifiApiError) {
    return error.status === 429 || error.status >= 500
  }
  return false
}

export async function apiFetch(baseUrl, path, { apiKey, method = 'GET', headers = {}, body = null, signal, binary = false } = {}) {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`
  const requestHeaders = {
    ...headers,
  }

  if (apiKey) {
    requestHeaders.Authorization = `Bearer ${apiKey}`
  }

  let response

  try {
    response = await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      signal,
    })
  } catch (error) {
    if (signal?.aborted) {
      throw new Error('Upload aborted.')
    }
    throw new BytifiNetworkError(error.message || 'Network request failed.', { cause: error })
  }

  const responseBuffer = Buffer.from(await response.arrayBuffer())

  if (!response.ok) {
    const text = responseBuffer.toString('utf8')
    let payload = text
    try {
      payload = JSON.parse(text)
    } catch {
      // keep text
    }

    const message = typeof payload === 'object' && payload?.error
      ? payload.error
      : typeof payload === 'string' && payload
        ? payload
        : `Request failed with status ${response.status}.`
    throw new BytifiApiError(message, {
      status: response.status,
      body: payload,
      retryAfterMs: response.status === 429 ? parseRetryAfterMs(response) : null,
    })
  }

  if (binary) {
    return responseBuffer
  }

  const text = responseBuffer.toString('utf8')
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

export async function apiFetchWithRetry(baseUrl, path, options = {}) {
  const {
    retries = MAX_RETRIES,
    rateLimitRetries = 0,
    maxRateLimitWaitMs = null,
    onStatus,
    signal,
    ...fetchOptions
  } = options

  let attempt = 0
  let rateLimitAttempt = 0
  const maxRateLimitRetries = rateLimitRetries === UNLIMITED_RATE_LIMIT_RETRIES
    ? UNLIMITED_RATE_LIMIT_RETRIES
    : (rateLimitRetries || retries)

  while (true) {
    try {
      return await apiFetch(baseUrl, path, { ...fetchOptions, signal })
    } catch (error) {
      if (signal?.aborted || error.message === 'Upload aborted.' || error.message === 'Decrypt aborted.') {
        throw error
      }

      if (error instanceof BytifiApiError && error.status === 429) {
        if (rateLimitAttempt >= maxRateLimitRetries) {
          throw error
        }

        rateLimitAttempt += 1
        const serverWaitMs = error.retryAfterMs ?? Math.min(600_000, 15_000 * rateLimitAttempt)
        const waitMs = maxRateLimitWaitMs == null
          ? serverWaitMs
          : Math.min(serverWaitMs, maxRateLimitWaitMs)

        onStatus?.({
          stage: 'waiting',
          message: maxRateLimitWaitMs != null && serverWaitMs > waitMs
            ? `Rate limited — retrying in ${formatDuration(waitMs)} (part upload continues when server allows)…`
            : `Rate limited — waiting ${formatDuration(waitMs)} before retry (${rateLimitAttempt})…`,
          waitMs,
          retryAttempt: rateLimitAttempt,
        })

        await sleep(waitMs)
        continue
      }

      if (!isRetryableError(error) || attempt >= retries) {
        throw error
      }

      attempt += 1
      await sleep(Math.min(1000 * (2 ** attempt), 8000))
    }
  }
}

export async function publicFetchWithRetry(baseUrl, path, options = {}) {
  return apiFetchWithRetry(baseUrl, path, {
    ...options,
    apiKey: null,
    rateLimitRetries: options.rateLimitRetries ?? UNLIMITED_RATE_LIMIT_RETRIES,
  })
}

export async function fetchPublicBinaryWithRetry(baseUrl, path, options = {}) {
  return apiFetchWithRetry(baseUrl, path, {
    ...options,
    apiKey: null,
    binary: true,
    rateLimitRetries: options.rateLimitRetries ?? UNLIMITED_RATE_LIMIT_RETRIES,
  })
}
