import fs from 'node:fs/promises'
import {
  apiFetchWithRetry,
  sleep,
} from './api.js'
import {
  MULTIPART_THRESHOLD_BYTES,
  encryptChunkFromFile,
  resolveUploadFile,
} from './crypto.js'

const DEFAULT_CONCURRENCY = 4
const POLL_INTERVAL_MS = 1500
const POLL_TIMEOUT_MS = 30 * 60 * 1000
const UNLIMITED_RATE_LIMIT_RETRIES = Number.POSITIVE_INFINITY

export { BytifiApiError, BytifiNetworkError, fetchPublicBinaryWithRetry, publicFetchWithRetry } from './api.js'

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

function uploadProgressPercent(completedParts, inFlightParts, totalParts) {
  const weighted = completedParts + inFlightParts * 0.5
  return Math.min(100, Math.round((weighted / totalParts) * 100))
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

      if (signal?.aborted) {
        throw new Error('Upload aborted.')
      }

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
  const clientEncryptionMeta = {
    ...context.meta,
    encryptedSize: encryptedBuffer.length,
  }

  formData.append('file', blob, context.originalName)
  formData.append('clientEncrypted', 'true')
  formData.append('clientEncryptionMeta', JSON.stringify(clientEncryptionMeta))
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

async function abortUploadSession(baseUrl, sessionToken, { apiKey, signal }) {
  await apiFetchWithRetry(baseUrl, '/api/public/upload/abort', {
    apiKey,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionToken }),
    signal,
    retries: 1,
  }).catch(() => {})
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
  const workerAbort = new AbortController()
  let nextChunkIndex = 0
  let completedParts = 0
  let inFlightParts = 0
  let sessionAborted = false

  const combinedSignal = AbortSignal.any?.([signal, workerAbort.signal])
    ?? (() => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      workerAbort.signal.addEventListener('abort', abort, { once: true })
      return controller.signal
    })()

  onProgress?.({
    stage: 'uploading',
    percent: 0,
    detail: `${workerCount} workers · session ${sessionToken.slice(0, 8)}…`,
  })

  function reportPartProgress(stage, partNumber, partBytes) {
    onProgress?.({
      stage,
      part: partNumber,
      totalParts: context.chunkCount,
      partBytes,
      percent: uploadProgressPercent(completedParts, inFlightParts, context.chunkCount),
    })
  }

  function claimChunkIndex() {
    const chunkIndex = nextChunkIndex
    nextChunkIndex += 1
    return chunkIndex
  }

  async function pipelineWorker() {
    while (true) {
      if (combinedSignal.aborted) {
        throw new Error('Upload aborted.')
      }

      const chunkIndex = claimChunkIndex()
      if (chunkIndex >= context.chunkCount) {
        return
      }

      const partNumber = chunkIndex + 1
      inFlightParts += 1

      try {
        reportPartProgress('encrypting', partNumber)

        const encryptedPart = await encryptChunkFromFile(fileHandle, chunkIndex, context)

        if (combinedSignal.aborted) {
          throw new Error('Upload aborted.')
        }

        reportPartProgress('uploading', partNumber, encryptedPart.length)

        await apiFetchWithRetry(
          baseUrl,
          `/api/public/upload/part?sessionToken=${encodeURIComponent(sessionToken)}&partNumber=${partNumber}`,
          {
            apiKey,
            method: 'PUT',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Upload-Session': sessionToken,
            },
            body: encryptedPart,
            signal: combinedSignal,
            onStatus,
            rateLimitRetries: UNLIMITED_RATE_LIMIT_RETRIES,
            maxRateLimitWaitMs: 15_000,
          },
        )

        completedParts += 1
        onProgress?.({
          stage: 'uploaded',
          part: partNumber,
          totalParts: context.chunkCount,
          partBytes: encryptedPart.length,
          percent: uploadProgressPercent(completedParts, inFlightParts, context.chunkCount),
          detail: `${completedParts}/${context.chunkCount} parts done`,
        })
      } finally {
        inFlightParts -= 1
      }
    }
  }

  try {
    await Promise.all(Array.from({ length: workerCount }, () => pipelineWorker()))
  } catch (error) {
    workerAbort.abort()

    if (!sessionAborted) {
      sessionAborted = true
      await abortUploadSession(baseUrl, sessionToken, { apiKey, signal })
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
