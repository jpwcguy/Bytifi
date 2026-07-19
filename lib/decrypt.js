import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  buildEncryptedChunkPlan,
  decryptChunk,
  importToken,
  normalizeClientEncryptionMeta,
} from './crypto.js'
import { fromBase64Url } from './base64url.js'
import { BytifiApiError, BytifiNetworkError } from './upload.js'

const DEFAULT_BASE_URL = 'https://bytifi.com'

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

async function publicFetch(baseUrl, requestPath, { signal } = {}) {
  const url = `${normalizeBaseUrl(baseUrl)}${requestPath}`

  let response

  try {
    response = await fetch(url, { signal })
  } catch (error) {
    if (signal?.aborted) {
      throw new Error('Decrypt aborted.')
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

export function parseDecryptInput(input, { encryptionToken = '', baseUrl = DEFAULT_BASE_URL } = {}) {
  const trimmed = String(input || '').trim()
  if (!trimmed) {
    throw new Error('Missing share URL or link token.')
  }

  let resolvedBaseUrl = normalizeBaseUrl(baseUrl)
  let linkToken = ''
  let resolvedEncryptionToken = String(encryptionToken || '').trim()

  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('/')) {
    const url = new URL(trimmed, `${resolvedBaseUrl}/`)

    if (url.origin !== 'null:') {
      resolvedBaseUrl = `${url.protocol}//${url.host}`
    }

    const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)
    if (!resolvedEncryptionToken) {
      resolvedEncryptionToken = hashParams.get('token') || ''
    }

    linkToken = url.searchParams.get('link') || ''

    if (!linkToken) {
      const fileMatch = url.pathname.match(/^\/f\/([^/]+)/)
      linkToken = fileMatch?.[1] || ''
    }
  } else {
    linkToken = trimmed
  }

  if (!linkToken) {
    throw new Error('Could not find a link token in the input URL.')
  }

  if (!resolvedEncryptionToken) {
    throw new Error(
      'Missing encryption token. Pass --token with the `#token=...` value from the share URL '
      + '(stored as `encryptionToken` in upload JSON). This is not the same as the link ID.',
    )
  }

  return {
    baseUrl: resolvedBaseUrl,
    linkToken,
    encryptionToken: resolvedEncryptionToken,
  }
}

export function parseShareReference(input, { encryptionToken = '', baseUrl = DEFAULT_BASE_URL } = {}) {
  const trimmed = String(input || '').trim()
  if (!trimmed) {
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      linkToken: '',
      encryptionToken: String(encryptionToken || '').trim(),
    }
  }

  if (!/^https?:\/\//i.test(trimmed) && !trimmed.startsWith('/')) {
    return {
      baseUrl: normalizeBaseUrl(baseUrl),
      linkToken: trimmed,
      encryptionToken: String(encryptionToken || '').trim(),
    }
  }

  const url = new URL(trimmed, `${normalizeBaseUrl(baseUrl)}/`)
  const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : url.hash)

  return {
    baseUrl: `${url.protocol}//${url.host}`,
    linkToken: url.searchParams.get('link') || url.pathname.match(/^\/f\/([^/]+)/)?.[1] || '',
    encryptionToken: String(encryptionToken || hashParams.get('token') || '').trim(),
  }
}

function looksLikeRemoteInput(input) {
  const trimmed = String(input || '').trim()
  return /^https?:\/\//i.test(trimmed)
    || trimmed.startsWith('/link')
    || trimmed.startsWith('/f/')
}

async function pathExists(inputPath) {
  try {
    await fs.access(path.resolve(inputPath))
    return true
  } catch {
    return false
  }
}

async function readMetaFile(metaPath) {
  const raw = await fs.readFile(path.resolve(metaPath), 'utf8')
  const parsed = JSON.parse(raw)
  const meta = normalizeClientEncryptionMeta(parsed?.clientEncryptionMeta || parsed)

  if (!meta) {
    throw new Error('Invalid encryption metadata file.')
  }

  return meta
}

async function resolveEncryptionMeta({
  metaPath = '',
  inlineMeta = null,
  linkToken = '',
  baseUrl = DEFAULT_BASE_URL,
  signal,
}) {
  if (inlineMeta) {
    return { meta: inlineMeta }
  }

  if (metaPath) {
    return { meta: await readMetaFile(metaPath) }
  }

  if (!linkToken) {
    throw new Error(
      'Missing link metadata for a downloaded file. Pass --upload-json upload.json, --link LINK_ID, or --meta meta.json.\n'
      + 'The link ID is the `link` field in upload JSON (also appears as /f/LINK_ID and link?link=LINK_ID).',
    )
  }

  const linkInfo = await fetchLinkInfo(baseUrl, linkToken, signal)

  if (linkInfo.status === 'expired') {
    throw new Error('This file link has expired.')
  }

  if (!linkInfo.clientEncrypted) {
    throw new Error('This link is not an encrypted file.')
  }

  const meta = normalizeClientEncryptionMeta(linkInfo.clientEncryptionMeta)
  if (!meta) {
    throw new Error('Invalid encryption metadata for this file.')
  }

  return { meta, linkInfo }
}

function sanitizeOutputName(filename) {
  const base = path.basename(String(filename || 'download').replace(/[\0\r\n]/g, ''))
  return base || 'download'
}

async function fetchLinkInfo(baseUrl, linkToken, signal) {
  return publicFetch(baseUrl, `/api/link/${encodeURIComponent(linkToken)}`, { signal })
}

async function fetchEncryptedPart(baseUrl, linkToken, partNumber, signal) {
  const response = await fetch(
    `${normalizeBaseUrl(baseUrl)}/f/${encodeURIComponent(linkToken)}/p/${partNumber}`,
    { signal },
  )

  if (!response.ok) {
    const text = await response.text()
    throw new BytifiApiError(text || `Failed to download part ${partNumber}.`, {
      status: response.status,
      body: text,
    })
  }

  return Buffer.from(await response.arrayBuffer())
}

async function decryptFromParts({
  baseUrl,
  linkToken,
  meta,
  tokenBytes,
  noncePrefix,
  outputPath,
  onProgress,
  signal,
}) {
  const { chunks } = buildEncryptedChunkPlan(meta)
  const fileHandle = await fs.open(outputPath, 'w')
  let decryptedBytes = 0

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      if (signal?.aborted) {
        throw new Error('Decrypt aborted.')
      }

      const chunk = chunks[index]
      const encryptedPart = await fetchEncryptedPart(baseUrl, linkToken, chunk.chunkIndex + 1, signal)
      const plainPart = decryptChunk(encryptedPart, tokenBytes, noncePrefix, chunk.chunkIndex)

      await fileHandle.write(plainPart)
      decryptedBytes += plainPart.length
      onProgress?.(Math.round((decryptedBytes / meta.originalSize) * 100))
    }
  } finally {
    await fileHandle.close()
  }
}

async function decryptFromSingleFile({
  encryptedFileUrl,
  meta,
  tokenBytes,
  noncePrefix,
  outputPath,
  onProgress,
  signal,
}) {
  const { chunks, totalEncryptedSize } = buildEncryptedChunkPlan(meta)
  const response = await fetch(encryptedFileUrl, { signal })

  if (!response.ok) {
    const text = await response.text()
    throw new BytifiApiError(text || 'Failed to download encrypted file.', {
      status: response.status,
      body: text,
    })
  }

  if (!response.body) {
    const encryptedBuffer = Buffer.from(await response.arrayBuffer())
    await writeDecryptedBuffer(encryptedBuffer, chunks, meta, tokenBytes, noncePrefix, outputPath, onProgress, signal)
    return
  }

  const reader = response.body.getReader()
  const fileHandle = await fs.open(outputPath, 'w')
  const pending = []
  let pendingLength = 0
  let downloadedBytes = 0
  let nextChunkIndex = 0
  let decryptedBytes = 0

  const takeBytes = (length) => {
    while (pendingLength < length) {
      return null
    }

    const out = Buffer.alloc(length)
    let offset = 0

    while (offset < length) {
      const head = pending[0]
      const take = Math.min(length - offset, head.length)
      head.copy(out, offset, 0, take)
      offset += take

      if (take === head.length) {
        pending.shift()
      } else {
        pending[0] = head.subarray(take)
      }
      pendingLength -= take
    }

    return out
  }

  try {
    while (nextChunkIndex < chunks.length) {
      if (signal?.aborted) {
        throw new Error('Decrypt aborted.')
      }

      const chunk = chunks[nextChunkIndex]

      while (pendingLength < chunk.encryptedSize) {
        const { done, value } = await reader.read()
        if (done) break
        const buffer = Buffer.from(value)
        pending.push(buffer)
        pendingLength += buffer.length
        downloadedBytes += buffer.length
        onProgress?.(Math.min(99, Math.round((downloadedBytes / totalEncryptedSize) * 100)))
      }

      const encryptedChunk = takeBytes(chunk.encryptedSize)
      if (!encryptedChunk) {
        throw new Error('Encrypted file ended before all parts were downloaded.')
      }

      const plainPart = decryptChunk(encryptedChunk, tokenBytes, noncePrefix, chunk.chunkIndex)
      await fileHandle.write(plainPart)
      decryptedBytes += plainPart.length
      nextChunkIndex += 1
      onProgress?.(Math.min(99, Math.round((decryptedBytes / meta.originalSize) * 100)))
    }
  } finally {
    await reader.cancel().catch(() => {})
    await fileHandle.close()
  }

  onProgress?.(100)
}

async function writeDecryptedBuffer(encryptedBuffer, chunks, meta, tokenBytes, noncePrefix, outputPath, onProgress, signal) {
  const fileHandle = await fs.open(outputPath, 'w')
  let offset = 0
  let decryptedBytes = 0

  try {
    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw new Error('Decrypt aborted.')
      }

      const encryptedChunk = encryptedBuffer.subarray(offset, offset + chunk.encryptedSize)
      if (encryptedChunk.length !== chunk.encryptedSize) {
        throw new Error('Encrypted file ended before all parts were downloaded.')
      }

      const plainPart = decryptChunk(encryptedChunk, tokenBytes, noncePrefix, chunk.chunkIndex)
      await fileHandle.write(plainPart)
      offset += chunk.encryptedSize
      decryptedBytes += plainPart.length
      onProgress?.(Math.round((decryptedBytes / meta.originalSize) * 100))
    }
  } finally {
    await fileHandle.close()
  }

  onProgress?.(100)
}

async function decryptFromLocalSingleFile({
  encryptedFilePath,
  meta,
  tokenBytes,
  noncePrefix,
  outputPath,
  onProgress,
  signal,
}) {
  const { chunks } = buildEncryptedChunkPlan(meta)
  const stat = await fs.stat(encryptedFilePath)

  if (stat.size <= 64 * 1024 * 1024) {
    const encryptedBuffer = await fs.readFile(encryptedFilePath)
    await writeDecryptedBuffer(encryptedBuffer, chunks, meta, tokenBytes, noncePrefix, outputPath, onProgress, signal)
    return
  }

  const fileHandle = await fs.open(encryptedFilePath, 'r')
  const outputHandle = await fs.open(outputPath, 'w')
  let offset = 0
  let decryptedBytes = 0

  try {
    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw new Error('Decrypt aborted.')
      }

      const encryptedChunk = Buffer.alloc(chunk.encryptedSize)
      const { bytesRead } = await fileHandle.read(encryptedChunk, 0, chunk.encryptedSize, offset)

      if (bytesRead !== chunk.encryptedSize) {
        throw new Error('Encrypted file ended before all parts were read.')
      }

      const plainPart = decryptChunk(encryptedChunk, tokenBytes, noncePrefix, chunk.chunkIndex)
      await outputHandle.write(plainPart)
      offset += chunk.encryptedSize
      decryptedBytes += plainPart.length
      onProgress?.(Math.round((decryptedBytes / meta.originalSize) * 100))
    }
  } finally {
    await fileHandle.close()
    await outputHandle.close()
  }

  onProgress?.(100)
}

async function listLocalPartFiles(dirPath) {
  const entries = await fs.readdir(dirPath)
  const parts = entries
    .map((name) => {
      const match = name.match(/^(\d+)(?:\.part)?$/)
      return match ? { partNumber: Number(match[1]), name } : null
    })
    .filter(Boolean)
    .sort((left, right) => left.partNumber - right.partNumber)

  if (parts.length === 0) {
    throw new Error('No numbered part files found in directory. Expected names like 1, 2, or 1.part, 2.part.')
  }

  return parts
}

async function decryptFromLocalParts({
  partsDirectory,
  meta,
  tokenBytes,
  noncePrefix,
  outputPath,
  onProgress,
  signal,
}) {
  const { chunks } = buildEncryptedChunkPlan(meta)
  const parts = await listLocalPartFiles(partsDirectory)

  if (parts.length !== chunks.length) {
    throw new Error(`Expected ${chunks.length} part files, found ${parts.length}.`)
  }

  const fileHandle = await fs.open(outputPath, 'w')
  let decryptedBytes = 0

  try {
    for (const chunk of chunks) {
      if (signal?.aborted) {
        throw new Error('Decrypt aborted.')
      }

      const partNumber = chunk.chunkIndex + 1
      const partEntry = parts[chunk.chunkIndex]

      if (!partEntry || partEntry.partNumber !== partNumber) {
        throw new Error(`Missing local part file ${partNumber}.`)
      }

      const encryptedPart = await fs.readFile(path.join(partsDirectory, partEntry.name))
      const plainPart = decryptChunk(encryptedPart, tokenBytes, noncePrefix, chunk.chunkIndex)

      await fileHandle.write(plainPart)
      decryptedBytes += plainPart.length
      onProgress?.(Math.round((decryptedBytes / meta.originalSize) * 100))
    }
  } finally {
    await fileHandle.close()
  }

  onProgress?.(100)
}

function hintTokenConfusion(encryptionToken, linkToken) {
  const token = String(encryptionToken || '').trim()

  if (!token || linkToken) return

  if (token.length <= 20) {
    throw new Error(
      `"${token}" looks like a link ID, not an encryption token.\n`
      + 'Use --link for the link ID (`link` in upload JSON) and --token for the encryption key (`encryptionToken`).\n'
      + 'Easiest: bytifi decrypt ./file.encrypted --upload-json upload.json',
    )
  }
}

export async function loadUploadJson(uploadJsonPath) {
  const raw = await fs.readFile(path.resolve(uploadJsonPath), 'utf8')
  let parsed

  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid upload JSON file.')
  }

  const meta = normalizeClientEncryptionMeta(parsed.clientEncryptionMeta)
  if (!meta) {
    throw new Error('Upload JSON is missing clientEncryptionMeta.')
  }

  const encryptionToken = String(parsed.encryptionToken || '').trim()
  if (!encryptionToken) {
    throw new Error('Upload JSON is missing encryptionToken.')
  }

  return {
    linkToken: String(parsed.link || parsed.token || '').trim(),
    encryptionToken,
    meta,
    originalName: parsed.originalName || 'download',
    shareUrl: parsed.shareUrl || '',
    expiresAt: parsed.expiresAt || null,
  }
}

async function applyUploadJsonDefaults(options) {
  if (!options.uploadJsonPath) {
    return options
  }

  const upload = await loadUploadJson(options.uploadJsonPath)

  return {
    ...options,
    linkToken: options.linkToken || upload.linkToken,
    encryptionToken: options.encryptionToken || upload.encryptionToken,
    inlineMeta: options.inlineMeta || upload.meta,
    originalName: options.originalName || upload.originalName,
    shareUrl: options.shareUrl || upload.shareUrl,
    uploadExpiresAt: upload.expiresAt,
  }
}

function resolveEncryptionToken(encryptionToken, shareReference, linkToken = '') {
  const resolved = String(encryptionToken || shareReference?.encryptionToken || '').trim()

  hintTokenConfusion(resolved, linkToken)

  if (!resolved) {
    throw new Error(
      'Missing encryption token. Pass --token with the `#token=...` value from the share URL '
      + '(stored as `encryptionToken` in upload JSON), or use --upload-json upload.json.',
    )
  }

  return resolved
}

function buildDecryptResult({
  outputPath,
  originalName,
  size,
  mimeType,
  expiresAt = null,
  linkToken = '',
  storageMode = 'single',
  sourcePath = '',
}) {
  return {
    outputPath,
    originalName,
    size,
    mimeType,
    expiresAt,
    link: linkToken,
    storageMode,
    sourcePath,
  }
}

async function decryptLocalFile(inputPath, options = {}) {
  const resolvedOptions = await applyUploadJsonDefaults(options)
  const absolutePath = path.resolve(inputPath)
  const stat = await fs.stat(absolutePath)
  const shareReference = parseShareReference(resolvedOptions.shareUrl || '', {
    encryptionToken: resolvedOptions.encryptionToken,
    baseUrl: resolvedOptions.baseUrl,
  })
  const linkToken = resolvedOptions.linkToken || shareReference.linkToken

  if (
    !resolvedOptions.uploadJsonPath
    && !resolvedOptions.metaPath
    && !resolvedOptions.inlineMeta
    && !linkToken
  ) {
    hintTokenConfusion(resolvedOptions.encryptionToken, '')
  }

  const resolved = await resolveEncryptionMeta({
    metaPath: resolvedOptions.metaPath,
    inlineMeta: resolvedOptions.inlineMeta,
    linkToken,
    baseUrl: resolvedOptions.baseUrl || shareReference.baseUrl,
    signal: resolvedOptions.signal,
  })
  const meta = resolved.meta || resolved
  const linkInfo = resolved.linkInfo || null
  const encryptionToken = resolveEncryptionToken(
    resolvedOptions.encryptionToken,
    shareReference,
    linkToken,
  )
  const tokenBytes = importToken(encryptionToken)
  const noncePrefix = fromBase64Url(meta.noncePrefix)
  const originalName = linkInfo?.originalName || resolvedOptions.originalName || 'download'
  const outputName = sanitizeOutputName(resolvedOptions.output ? path.basename(resolvedOptions.output) : originalName)
  const outputPath = path.resolve(
    resolvedOptions.output || path.join(resolvedOptions.outputDirectory || process.cwd(), outputName),
  )

  await fs.mkdir(path.dirname(outputPath), { recursive: true })

  if (stat.isDirectory()) {
    await decryptFromLocalParts({
      partsDirectory: absolutePath,
      meta,
      tokenBytes,
      noncePrefix,
      outputPath,
      onProgress: resolvedOptions.onProgress,
      signal: resolvedOptions.signal,
    })

    return buildDecryptResult({
      outputPath,
      originalName,
      size: meta.originalSize,
      mimeType: meta.mimeType,
      expiresAt: linkInfo?.expiresAt || resolvedOptions.uploadExpiresAt || null,
      linkToken,
      storageMode: 'parts',
      sourcePath: absolutePath,
    })
  }

  await decryptFromLocalSingleFile({
    encryptedFilePath: absolutePath,
    meta,
    tokenBytes,
    noncePrefix,
    outputPath,
    onProgress: resolvedOptions.onProgress,
    signal: resolvedOptions.signal,
  })

  return buildDecryptResult({
    outputPath,
    originalName,
    size: meta.originalSize,
    mimeType: meta.mimeType,
    expiresAt: linkInfo?.expiresAt || resolvedOptions.uploadExpiresAt || null,
    linkToken,
    storageMode: 'single',
    sourcePath: absolutePath,
  })
}

export async function decryptFile(input, options = {}) {
  const resolvedOptions = await applyUploadJsonDefaults(options)
  const trimmedInput = String(input || '').trim()
  if (!trimmedInput) {
    throw new Error('Missing share URL, link token, or encrypted file path.')
  }

  if (resolvedOptions.localFile || (!looksLikeRemoteInput(trimmedInput) && await pathExists(trimmedInput))) {
    return decryptLocalFile(trimmedInput, resolvedOptions)
  }

  const parsed = parseDecryptInput(trimmedInput, {
    encryptionToken: resolvedOptions.encryptionToken,
    baseUrl: resolvedOptions.baseUrl,
  })

  const linkInfo = await fetchLinkInfo(parsed.baseUrl, parsed.linkToken, resolvedOptions.signal)

  if (linkInfo.status === 'expired') {
    throw new Error('This file link has expired.')
  }

  if (!linkInfo.clientEncrypted) {
    throw new Error('This link is not an encrypted file.')
  }

  const meta = normalizeClientEncryptionMeta(linkInfo.clientEncryptionMeta)
  if (!meta) {
    throw new Error('Invalid encryption metadata for this file.')
  }

  const tokenBytes = importToken(parsed.encryptionToken)
  const noncePrefix = fromBase64Url(meta.noncePrefix)
  const outputName = sanitizeOutputName(
    resolvedOptions.output ? path.basename(resolvedOptions.output) : linkInfo.originalName,
  )
  const outputPath = path.resolve(
    resolvedOptions.output || path.join(resolvedOptions.outputDirectory || process.cwd(), outputName),
  )

  await fs.mkdir(path.dirname(outputPath), { recursive: true })

  if (linkInfo.storageMode === 'parts') {
    await decryptFromParts({
      baseUrl: parsed.baseUrl,
      linkToken: parsed.linkToken,
      meta,
      tokenBytes,
      noncePrefix,
      outputPath,
      onProgress: resolvedOptions.onProgress,
      signal: resolvedOptions.signal,
    })
  } else {
    const encryptedFileUrl = linkInfo.downloadUrl
      || `${parsed.baseUrl}/f/${encodeURIComponent(parsed.linkToken)}`

    await decryptFromSingleFile({
      encryptedFileUrl,
      meta,
      tokenBytes,
      noncePrefix,
      outputPath,
      onProgress: resolvedOptions.onProgress,
      signal: resolvedOptions.signal,
    })
  }

  return buildDecryptResult({
    outputPath,
    originalName: linkInfo.originalName,
    size: linkInfo.size,
    mimeType: linkInfo.mimeType,
    expiresAt: linkInfo.expiresAt,
    linkToken: parsed.linkToken,
    storageMode: linkInfo.storageMode || 'single',
  })
}
