import {
  MULTIPART_THRESHOLD_BYTES,
  encryptChunkFromFile,
  resolveUploadFile,
} from './crypto.js'
import { formatDuration } from './progress.js'
import fs from 'node:fs/promises'

const DEFAULT_BASE_URL = 'https://bytifi.com'
const DEFAULT_CONCURRENCY = 4
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 30 * 60 * 1000
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

function isRetryableError(error) {
  if (error instanceof BytifiNetworkError) return true
  if (error instanceof BytifiApiError) {
    return error.status === 429 || error.status >= 500
  }
  return false
}

function parseRetryAfterMs(response) {
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

async function readResponseBody(response) {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function apiFetch(baseUrl, path, { apiKey, method = 'GET', headers = {}, body = null, signal, binary = false } = {}) {
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

async function apiFetchWithRetry(baseUrl, path, options = {}) {
  const {
    retries = MAX_RETRIES,
    rateLimitRetries = 0,
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
        const waitMs = error.retryAfterMs ?? Math.min(600_000, 15_000 * rateLimitAttempt)

        onStatus?.({
          stage: 'waiting',
          message: `Rate limited — waiting ${formatDuration(waitMs)} before retry (${rateLimitAttempt})…`,
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

function buildShareUrl(payload, encryptionToken) {
  return `${payload.url}#token=${encodeURIComponent(encryptionToken)}`
}

function buildResult(payload, context, shareUrl) {
  return {
    shareUrl,
    url: payload.url,
    encryptedFile: payload.downloadUrl,
    link: payload.token,
    encryptionToken: context.token,
    clientEncryptionMeta: context.meta,
    originalName: payload.originalName || context.originalName,
    size: payload.size,
    expiresAt: payload.expiresAt,
    deleteOnDownload: payload.deleteOnDownload,
    clientEncrypted: payload.clientEncrypted,
    compression: context.compression,
  }
}

async function collectEncryptedBuffer(filePath, context, { onProgress, signal } = {}) {
  const fileHandle = await fs.open(filePath, 'r')
  const encryptedParts = []

  try {
    for (let chunkIndex = 0; chunkIndex < context.chunkCount; chunkIndex += 1) {
      if (signal?.aborted) {
        throw new Error('Upload aborted.')
      }

      onProgress?.({
        stage: 'encrypting',
        part: chunkIndex + 1,
        totalParts: context.chunkCount,
        percent: Math.round((chunkIndex / context.chunkCount) * 90),
      })

      encryptedParts.push(await encryptChunkFromFile(fileHandle, chunkIndex, context))
      onProgress?.({
        stage: 'encrypted',
        part: chunkIndex + 1,
        totalParts: context.chunkCount,
        percent: Math.round(((chunkIndex + 1) / context.chunkCount) * 90),
      })
    }
  } finally {
    await fileHandle.close()
  }

  onProgress?.({ stage: 'uploading', percent: 95, detail: 'direct upload' })
  return Buffer.concat(encryptedParts)
}

async function uploadDirect(context, encryptedBuffer, {
  apiKey,
  baseUrl,
  expiresInMinutes,
  deleteOnDownload,
  onProgress,
  onStatus,
  signal,
}) {
  const formData = new FormData()
  const blob = new Blob([encryptedBuffer], { type: 'application/octet-stream' })

  formData.append('file', blob, context.originalName)
  formData.append('clientEncrypted', 'true')
  formData.append('clientEncryptionMeta', JSON.stringify(context.meta))
  formData.append('deleteOnDownload', deleteOnDownload ? 'true' : 'false')
  formData.append('expiresInMinutes', String(expiresInMinutes))

  const payload = await apiFetchWithRetry(baseUrl, '/api/public/upload', {
    apiKey,
    method: 'POST',
    body: formData,
    signal,
    onStatus,
    rateLimitRetries: UNLIMITED_RATE_LIMIT_RETRIES,
  })

  onProgress?.({ stage: 'complete', percent: 100 })

  const shareUrl = buildShareUrl(payload, context.token)
  return buildResult(payload, context, shareUrl)
}

async function pollUploadStatus(sessionToken, { apiKey, baseUrl, signal, onStatus }) {
  const startedAt = Date.now()

  while (true) {
    if (signal?.aborted) {
      throw new Error('Upload aborted.')
    }

    if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
      throw new Error('Upload finalization timed out. Try again later.')
    }

    const payload = await apiFetchWithRetry(
      baseUrl,
      `/api/public/upload/status?sessionToken=${encodeURIComponent(sessionToken)}`,
      {
        apiKey,
        signal,
        onStatus,
        rateLimitRetries: UNLIMITED_RATE_LIMIT_RETRIES,
      },
    )

    if (payload.status !== 'processing' && payload.status !== 'pending') {
      return payload
    }

    onStatus?.({
      stage: 'finalizing',
      percent: Math.min(99, Math.round(Number(payload?.progress?.percent || 0))),
      detail: payload?.progress?.phase || 'processing on server',
    })

    await sleep(POLL_INTERVAL_MS)
  }
}

function resolveUploadConcurrency(originalSize, requested) {
  const requestedValue = Number(requested)
  if (Number.isFinite(requestedValue) && requestedValue > 0) {
    return Math.min(16, Math.max(1, Math.floor(requestedValue)))
  }

  if (originalSize >= 3 * 1024 * 1024 * 1024) return 2
  if (originalSize >= 1024 * 1024 * 1024) return 3
  return DEFAULT_CONCURRENCY
}

async function uploadMultipartStreaming(filePath, context, {
  apiKey,
  baseUrl,
  expiresInMinutes,
  deleteOnDownload,
  onProgress,
  onStatus,
  signal,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const maxPartSize = context.meta.chunkSize + 16

  onProgress?.({
    stage: 'starting',
    percent: 0,
    detail: `${context.chunkCount} parts · ${context.compression === 'gzip' ? 'gzip' : 'raw'} chunks`,
  })

  const initPayload = await apiFetchWithRetry(baseUrl, '/api/public/upload/init', {
    apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      originalName: context.originalName,
      mimeType: context.mimeType,
      size: context.encryptedSize,
      originalSize: context.originalSize,
      clientEncrypted: true,
      clientEncryptionMeta: context.meta,
      partSize: maxPartSize,
      expiresInMinutes,
      deleteOnDownload,
    }),
    signal,
    onStatus,
    rateLimitRetries: UNLIMITED_RATE_LIMIT_RETRIES,
  })

  const sessionToken = initPayload.sessionToken
  const workerCount = Math.min(
    resolveUploadConcurrency(context.originalSize, concurrency || initPayload.concurrency),
    context.chunkCount,
  )
  const fileHandle = await fs.open(filePath, 'r')
  let nextChunkIndex = 0
  let completedParts = 0

  onProgress?.({
    stage: 'uploading',
    percent: 0,
    detail: `${workerCount} workers · session ${sessionToken.slice(0, 8)}…`,
  })

  function claimChunkIndex() {
    const chunkIndex = nextChunkIndex
    nextChunkIndex += 1
    return chunkIndex
  }

  async function pipelineWorker() {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Upload aborted.')
      }

      const chunkIndex = claimChunkIndex()
      if (chunkIndex >= context.chunkCount) {
        return
      }

      const partNumber = chunkIndex + 1

      onProgress?.({
        stage: 'encrypting',
        part: partNumber,
        totalParts: context.chunkCount,
        percent: Math.round((completedParts / context.chunkCount) * 100),
      })

      const encryptedPart = await encryptChunkFromFile(fileHandle, chunkIndex, context)

      onProgress?.({
        stage: 'uploading',
        part: partNumber,
        totalParts: context.chunkCount,
        partBytes: encryptedPart.length,
        percent: Math.round((completedParts / context.chunkCount) * 100),
      })

      await apiFetchWithRetry(
        baseUrl,
        `/api/public/upload/part?sessionToken=${encodeURIComponent(sessionToken)}&partNumber=${partNumber}`,
        {
          apiKey,
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: encryptedPart,
          signal,
          onStatus,
          rateLimitRetries: UNLIMITED_RATE_LIMIT_RETRIES,
        },
      )

      completedParts += 1
      onProgress?.({
        stage: 'uploaded',
        part: partNumber,
        totalParts: context.chunkCount,
        partBytes: encryptedPart.length,
        percent: Math.round((completedParts / context.chunkCount) * 100),
        detail: `${completedParts}/${context.chunkCount} parts done`,
      })
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => pipelineWorker()))
  } catch (error) {
    if (!(error instanceof BytifiApiError && error.status === 429)) {
      await apiFetchWithRetry(baseUrl, '/api/public/upload/abort', {
        apiKey,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken }),
        signal,
      }).catch(() => {})
    }

    throw error
  } finally {
    await fileHandle.close()
  }

  onProgress?.({ stage: 'finalizing', percent: 99, detail: 'completing upload session' })

  let completePayload = await apiFetchWithRetry(baseUrl, '/api/public/upload/complete', {
    apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
    signal,
    onStatus,
    rateLimitRetries: UNLIMITED_RATE_LIMIT_RETRIES,
  })

  if (completePayload.status === 'processing' || completePayload.status === 'pending') {
    completePayload = await pollUploadStatus(sessionToken, { apiKey, baseUrl, signal, onStatus })
  }

  onProgress?.({ stage: 'complete', percent: 100 })

  const shareUrl = buildShareUrl(completePayload, context.token)
  return buildResult(completePayload, context, shareUrl)
}

export async function uploadFile(filePath, options) {
  if (!options?.apiKey) {
    throw new Error('API key is required.')
  }

  const reportStatus = (info) => {
    options.onStatus?.(info)
    options.onProgress?.(info)
  }

  const uploadOptions = {
    ...options,
    onStatus: reportStatus,
  }

  const { absolutePath, context } = await resolveUploadFile(filePath, {
    mimeType: options.mimeType,
  })

  if (context.originalSize <= MULTIPART_THRESHOLD_BYTES) {
    const encryptedBuffer = await collectEncryptedBuffer(absolutePath, context, {
      onProgress: reportStatus,
      signal: options.signal,
    })

    return uploadDirect(context, encryptedBuffer, uploadOptions)
  }

  return uploadMultipartStreaming(absolutePath, context, uploadOptions)
}
