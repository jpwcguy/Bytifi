import {
  DIRECT_UPLOAD_LIMIT_BYTES,
  collectEncryptedParts,
  encryptChunkFromFile,
  resolveUploadFile,
} from './crypto.js'
import fs from 'node:fs/promises'

const DEFAULT_BASE_URL = 'https://bytifi.com'

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

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
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

async function apiFetch(baseUrl, path, { apiKey, method = 'GET', headers = {}, body = null } = {}) {
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
    })
  } catch (error) {
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

function buildShareUrl(payload, encryptionToken) {
  return `${payload.url}#token=${encodeURIComponent(encryptionToken)}`
}

function buildResult(payload, context, shareUrl) {
  return {
    shareUrl,
    url: payload.url,
    downloadUrl: payload.downloadUrl,
    token: payload.token,
    encryptionToken: context.token,
    originalName: payload.originalName || context.originalName,
    size: payload.size,
    expiresAt: payload.expiresAt,
    deleteOnDownload: payload.deleteOnDownload,
    clientEncrypted: payload.clientEncrypted,
  }
}

async function uploadDirect(context, encryptedBuffer, {
  apiKey,
  baseUrl,
  expiresInMinutes,
  deleteOnDownload,
}) {
  const formData = new FormData()
  const blob = new Blob([encryptedBuffer], { type: 'application/octet-stream' })

  formData.append('file', blob, context.originalName)
  formData.append('clientEncrypted', 'true')
  formData.append('clientEncryptionMeta', JSON.stringify(context.meta))
  formData.append('deleteOnDownload', deleteOnDownload ? 'true' : 'false')
  formData.append('expiresInMinutes', String(expiresInMinutes))

  const payload = await apiFetch(baseUrl, '/api/public/upload', {
    apiKey,
    method: 'POST',
    body: formData,
  })

  const shareUrl = buildShareUrl(payload, context.token)
  return buildResult(payload, context, shareUrl)
}

async function pollUploadStatus(sessionToken, { apiKey, baseUrl, signal }) {
  while (true) {
    if (signal?.aborted) {
      throw new Error('Upload aborted.')
    }

    const payload = await apiFetch(
      baseUrl,
      `/api/public/upload/status?sessionToken=${encodeURIComponent(sessionToken)}`,
      { apiKey },
    )

    if (payload.status !== 'processing') {
      return payload
    }

    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

async function uploadMultipartStreaming(filePath, context, {
  apiKey,
  baseUrl,
  expiresInMinutes,
  deleteOnDownload,
  onProgress,
  signal,
}) {
  const partSize = context.meta.chunkSize + 16
  const initPayload = await apiFetch(baseUrl, '/api/public/upload/init', {
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
      partSize,
      expiresInMinutes,
      deleteOnDownload,
    }),
  })

  const sessionToken = initPayload.sessionToken
  const fileHandle = await fs.open(filePath, 'r')

  try {
    for (let chunkIndex = 0; chunkIndex < context.chunkCount; chunkIndex += 1) {
      if (signal?.aborted) {
        throw new Error('Upload aborted.')
      }

      const partNumber = chunkIndex + 1
      const encryptedPart = await encryptChunkFromFile(fileHandle, chunkIndex, context)

      await apiFetch(
        baseUrl,
        `/api/public/upload/part?sessionToken=${encodeURIComponent(sessionToken)}&partNumber=${partNumber}`,
        {
          apiKey,
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: encryptedPart,
        },
      )

      onProgress?.(Math.round((partNumber / context.chunkCount) * 100))
    }
  } catch (error) {
    await apiFetch(baseUrl, '/api/public/upload/abort', {
      apiKey,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken }),
    }).catch(() => {})

    throw error
  } finally {
    await fileHandle.close()
  }

  let completePayload = await apiFetch(baseUrl, '/api/public/upload/complete', {
    apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
  })

  if (completePayload.status === 'processing') {
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

  if (context.encryptedSize <= DIRECT_UPLOAD_LIMIT_BYTES) {
    const encryptedParts = await collectEncryptedParts(absolutePath, context)
    const encryptedBuffer = Buffer.concat(encryptedParts)

    return uploadDirect(context, encryptedBuffer, options)
  }

  return uploadMultipartStreaming(absolutePath, context, options)
}
