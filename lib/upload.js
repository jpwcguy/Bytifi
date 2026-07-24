import {
  MULTIPART_THRESHOLD_BYTES,
  encryptChunkFromFile,
  resolveUploadFile,
} from './crypto.js'
import fs from 'node:fs/promises'

const DEFAULT_BASE_URL = 'https://bytifi.com'
const DEFAULT_CONCURRENCY = 4
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 30 * 60 * 1000
const MAX_RETRIES = 3

export class BytifiApiError extends Error {
  constructor(message, { status = 0, body = null } = {}) {
    super(message)
    this.name = 'BytifiApiError'
    this.status = status
    this.body = body
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

async function readResponseBody(response) {
  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function apiFetch(baseUrl, path, { apiKey, method = 'GET', headers = {}, body = null, signal } = {}) {
  const url = `${normalizeBaseUrl(baseUrl)}${path}`
  const requestHeaders = {
    Authorization: `Bearer ${apiKey}`,
    ...headers,
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

  const payload = await readResponseBody(response)

  if (!response.ok) {
    const message = typeof payload === 'object' && payload?.error
      ? payload.error
      : typeof payload === 'string' && payload
        ? payload
        : `Request failed with status ${response.status}.`
    throw new BytifiApiError(message, { status: response.status, body: payload })
  }

  return payload
}

async function apiFetchWithRetry(baseUrl, path, options = {}) {
  const { retries = MAX_RETRIES, signal } = options

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await apiFetch(baseUrl, path, options)
    } catch (error) {
      if (signal?.aborted || error.message === 'Upload aborted.') {
        throw error
      }

      if (!isRetryableError(error) || attempt === retries) {
        throw error
      }

      const delayMs = Math.min(1000 * (2 ** attempt), 8000)
      await sleep(delayMs)
    }
  }

  throw new Error('Request failed after retries.')
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

function createBoundedQueue(maxSize) {
  const items = []
  const waiters = []
  let closed = false

  function notifyWaiters() {
    while (waiters.length > 0) {
      const resolve = waiters.shift()
      resolve()
    }
  }

  return {
    async push(item, signal) {
      while (items.length >= maxSize) {
        if (signal?.aborted) {
          throw new Error('Upload aborted.')
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const index = waiters.indexOf(resolve)
            if (index >= 0) waiters.splice(index, 1)
            reject(new Error('Upload aborted.'))
          }
          waiters.push(resolve)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }

      items.push(item)
      notifyWaiters()
    },
    async take(signal) {
      while (items.length === 0) {
        if (closed) {
          return null
        }
        if (signal?.aborted) {
          throw new Error('Upload aborted.')
        }
        await new Promise((resolve, reject) => {
          const onAbort = () => {
            const index = waiters.indexOf(resolve)
            if (index >= 0) waiters.splice(index, 1)
            reject(new Error('Upload aborted.'))
          }
          waiters.push(resolve)
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      }

      return items.shift()
    },
    close() {
      closed = true
      notifyWaiters()
    },
    get pending() {
      return items.length
    },
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

      encryptedParts.push(await encryptChunkFromFile(fileHandle, chunkIndex, context))
      onProgress?.(Math.round(((chunkIndex + 1) / context.chunkCount) * 90))
    }
  } finally {
    await fileHandle.close()
  }

  onProgress?.(95)
  return Buffer.concat(encryptedParts)
}

async function uploadDirect(context, encryptedBuffer, {
  apiKey,
  baseUrl,
  expiresInMinutes,
  deleteOnDownload,
  onProgress,
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
  })

  onProgress?.(100)

  const shareUrl = buildShareUrl(payload, context.token)
  return buildResult(payload, context, shareUrl)
}

async function pollUploadStatus(sessionToken, { apiKey, baseUrl, signal }) {
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
      { apiKey, signal },
    )

    if (payload.status !== 'processing' && payload.status !== 'pending') {
      return payload
    }

    await sleep(POLL_INTERVAL_MS)
  }
}

async function uploadMultipartStreaming(filePath, context, {
  apiKey,
  baseUrl,
  expiresInMinutes,
  deleteOnDownload,
  onProgress,
  signal,
  concurrency = DEFAULT_CONCURRENCY,
}) {
  const maxPartSize = context.meta.chunkSize + 16
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
  })

  const sessionToken = initPayload.sessionToken
  const workerCount = Math.min(
    Number(concurrency) || Number(initPayload.concurrency) || DEFAULT_CONCURRENCY,
    context.chunkCount,
  )
  const queue = createBoundedQueue(Math.max(2, workerCount * 2))
  const fileHandle = await fs.open(filePath, 'r')
  let nextChunkIndex = 0
  let completedParts = 0

  function claimChunkIndex() {
    const chunkIndex = nextChunkIndex
    nextChunkIndex += 1
    return chunkIndex
  }

  async function encryptWorker() {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Upload aborted.')
      }

      const chunkIndex = claimChunkIndex()
      if (chunkIndex >= context.chunkCount) {
        return
      }

      const encryptedPart = await encryptChunkFromFile(fileHandle, chunkIndex, context)
      await queue.push({
        partNumber: chunkIndex + 1,
        body: encryptedPart,
      }, signal)
    }
  }

  async function uploadWorker() {
    while (true) {
      if (signal?.aborted) {
        throw new Error('Upload aborted.')
      }

      const part = await queue.take(signal)
      if (!part) {
        return
      }

      await apiFetchWithRetry(
        baseUrl,
        `/api/public/upload/part?sessionToken=${encodeURIComponent(sessionToken)}&partNumber=${part.partNumber}`,
        {
          apiKey,
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: part.body,
          signal,
        },
      )

      completedParts += 1
      onProgress?.(Math.round((completedParts / context.chunkCount) * 100))
    }
  }

  try {
    const uploadWorkers = Array.from({ length: workerCount }, () => uploadWorker())
    const encryptWorkers = Array.from({ length: workerCount }, () => encryptWorker())
    await Promise.all(encryptWorkers)
    queue.close()
    await Promise.all(uploadWorkers)
  } catch (error) {
    await apiFetchWithRetry(baseUrl, '/api/public/upload/abort', {
      apiKey,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
      signal,
    }).catch(() => {})

    throw error
  } finally {
    await fileHandle.close()
  }

  let completePayload = await apiFetchWithRetry(baseUrl, '/api/public/upload/complete', {
    apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
    signal,
  })

  if (completePayload.status === 'processing' || completePayload.status === 'pending') {
    completePayload = await pollUploadStatus(sessionToken, { apiKey, baseUrl, signal })
  }

  const shareUrl = buildShareUrl(completePayload, context.token)
  return buildResult(completePayload, context, shareUrl)
}

export async function uploadFile(filePath, options) {
  if (!options?.apiKey) {
    throw new Error('API key is required.')
  }

  const { absolutePath, context } = await resolveUploadFile(filePath, {
    mimeType: options.mimeType,
  })

  if (context.originalSize <= MULTIPART_THRESHOLD_BYTES) {
    const encryptedBuffer = await collectEncryptedBuffer(absolutePath, context, {
      onProgress: options.onProgress,
      signal: options.signal,
    })

    return uploadDirect(context, encryptedBuffer, options)
  }

  return uploadMultipartStreaming(absolutePath, context, options)
}
