import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  buildEncryptedChunkPlan,
  decryptPlainChunkFromEncrypted,
  importToken,
  normalizeClientEncryptionMeta,
  usesChunkCompression,
} from './crypto.js'
import { fromBase64Url } from './base64url.js'
import { fetchPublicBinaryWithRetry, publicFetchWithRetry } from './api.js'
import { normalizeBaseUrl } from './url.js'

const DEFAULT_DECRYPT_CONCURRENCY = 2

function decryptProgress(overrides) {
  return { stage: 'decrypting', percent: 0, ...overrides }
}

function resolveDecryptConcurrency(requested) {
  const value = Number(requested)
  if (Number.isFinite(value) && value > 0) {
    return Math.min(8, Math.max(1, Math.floor(value)))
  }
  return DEFAULT_DECRYPT_CONCURRENCY
}

export function parseDecryptInput(input, { encryptionToken = '', baseUrl = undefined } = {}) {
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

export function parseShareReference(input, { encryptionToken = '', baseUrl = undefined } = {}) {
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
  baseUrl,
  signal,
  onStatus,
}) {
  if (inlineMeta) {
    return { meta: inlineMeta, skipApiMetaFetch: true }
  }

  if (metaPath) {
    return { meta: await readMetaFile(metaPath), skipApiMetaFetch: true }
  }

  if (!linkToken) {
    throw new Error(
      'Missing link metadata for a downloaded file. Pass --upload-json upload.json, --link LINK_ID, or --meta meta.json.\n'
      + 'The link ID is the `link` field in upload JSON (also appears as /f/LINK_ID and link?link=LINK_ID).',
    )
  }

  const linkInfo = await fetchLinkInfo(baseUrl, linkToken, signal, onStatus)

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

async function cleanupPartialOutput(outputPath) {
  await fs.unlink(outputPath).catch(() => {})
}

async function fetchLinkInfo(baseUrl, linkToken, signal, onStatus) {
  return publicFetchWithRetry(baseUrl, `/api/link/${encodeURIComponent(linkToken)}`, { signal, onStatus })
}

async function fetchEncryptedPart(baseUrl, linkToken, partNumber, signal, onStatus) {
  return fetchPublicBinaryWithRetry(
    baseUrl,
    `/f/${encodeURIComponent(linkToken)}/p/${partNumber}`,
    { signal, onStatus },
  )
}

function splitDownloadUrl(encryptedFileUrl, fallbackBaseUrl) {
  const url = new URL(encryptedFileUrl, `${normalizeBaseUrl(fallbackBaseUrl)}/`)
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    path: `${url.pathname}${url.search}`,
  }
}

async function decryptFromParts({
  baseUrl,
  linkToken,
  meta,
  tokenBytes,
  noncePrefix,
  outputPath,
  onProgress,
  onStatus,
  signal,
  concurrency = DEFAULT_DECRYPT_CONCURRENCY,
}) {
  const { chunks } = buildEncryptedChunkPlan(meta)
  let decryptedBytes = 0
  const workerCount = Math.min(resolveDecryptConcurrency(concurrency), chunks.length)
  let nextIndex = 0
  let completedParts = 0
  let inFlightParts = 0
  const workerAbort = new AbortController()
  const abortSignals = signal ? [signal, workerAbort.signal] : [workerAbort.signal]
  const combinedSignal = AbortSignal.any?.(abortSignals)
    ?? (() => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      signal?.addEventListener('abort', abort, { once: true })
      workerAbort.signal.addEventListener('abort', abort, { once: true })
      return controller.signal
    })()

  function partPercent() {
    const weighted = completedParts + inFlightParts * 0.5
    return Math.min(100, Math.round((weighted / chunks.length) * 100))
  }

  async function processPart(index) {
    if (combinedSignal.aborted) {
      throw new Error('Decrypt aborted.')
    }

    const chunk = chunks[index]
    const partNumber = chunk.chunkIndex + 1
    inFlightParts += 1

    try {
      onProgress?.(decryptProgress({
        stage: 'downloading',
        part: partNumber,
        totalParts: chunks.length,
        totalBytes: meta.originalSize,
        percent: partPercent(),
      }))

      const encryptedPart = await fetchEncryptedPart(baseUrl, linkToken, partNumber, combinedSignal, onStatus)

      onProgress?.(decryptProgress({
        stage: 'decrypting',
        part: partNumber,
        totalParts: chunks.length,
        partBytes: encryptedPart.length,
        percent: partPercent(),
      }))

      const plainPart = await decryptPlainChunkFromEncrypted(
        encryptedPart,
        tokenBytes,
        noncePrefix,
        chunk.chunkIndex,
        meta,
      )

      return { index, partNumber, plainPart }
    } finally {
      inFlightParts -= 1
    }
  }

  let fileHandle
  try {
    const results = new Array(chunks.length)
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= chunks.length) return

        const result = await processPart(index)
        results[result.index] = result.plainPart
        completedParts += 1
        decryptedBytes += result.plainPart.length

        onProgress?.(decryptProgress({
          stage: 'writing',
          part: result.partNumber,
          totalParts: chunks.length,
          downloadedBytes: decryptedBytes,
          totalBytes: meta.originalSize,
          percent: Math.round((decryptedBytes / meta.originalSize) * 100),
          detail: `${completedParts}/${chunks.length} parts`,
        }))
      }
    })

    await Promise.all(workers)

    // Open only after all parts decrypt successfully so Windows cleanup can unlink on failure.
    fileHandle = await fs.open(outputPath, 'w')
    for (const plainPart of results) {
      await fileHandle.write(plainPart)
    }
  } catch (error) {
    workerAbort.abort()
    await cleanupPartialOutput(outputPath)
    throw error
  } finally {
    await fileHandle?.close()
  }

  onProgress?.({ stage: 'complete', percent: 100 })
}

async function decryptFromSingleFile({
  encryptedFileUrl,
  meta,
  tokenBytes,
  noncePrefix,
  outputPath,
  onProgress,
  onStatus,
  signal,
  baseUrl,
}) {
  const { baseUrl: downloadBaseUrl, path: downloadPath } = splitDownloadUrl(encryptedFileUrl, baseUrl)

  if (usesChunkCompression(meta)) {
    if (meta.chunkCount !== 1) {
      throw new Error(
        'Compressed files with multiple chunks require part-based download. Open the share link in a browser or use part files.',
      )
    }

    const encryptedBuffer = await fetchPublicBinaryWithRetry(downloadBaseUrl, downloadPath, { signal, onStatus })
    const plainPart = await decryptPlainChunkFromEncrypted(
      encryptedBuffer,
      tokenBytes,
      noncePrefix,
      0,
      meta,
    )

    try {
      await fs.writeFile(outputPath, plainPart)
    } catch (error) {
      await cleanupPartialOutput(outputPath)
      throw error
    }

    onProgress?.({ stage: 'complete', percent: 100 })
    return
  }

  const { chunks, totalEncryptedSize } = buildEncryptedChunkPlan(meta)
  const encryptedBuffer = await fetchPublicBinaryWithRetry(downloadBaseUrl, downloadPath, { signal, onStatus })

  try {
    await writeDecryptedBuffer(encryptedBuffer, chunks, meta, tokenBytes, noncePrefix, outputPath, onProgress, signal)
  } catch (error) {
    await cleanupPartialOutput(outputPath)
    throw error
  }
}

async function writeDecryptedBuffer(encryptedBuffer, chunks, meta, tokenBytes, noncePrefix, outputPath, onProgress, signal) {
  if (usesChunkCompression(meta)) {
    if (chunks.length !== 1) {
      throw new Error('Compressed files with multiple chunks require part-based storage.')
    }

    const plainPart = await decryptPlainChunkFromEncrypted(
      encryptedBuffer,
      tokenBytes,
      noncePrefix,
      0,
      meta,
    )
    await fs.writeFile(outputPath, plainPart)
    onProgress?.({ stage: 'complete', percent: 100 })
    return
  }

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

      const plainPart = await decryptPlainChunkFromEncrypted(
        encryptedChunk,
        tokenBytes,
        noncePrefix,
        chunk.chunkIndex,
        meta,
      )
      await fileHandle.write(plainPart)
      offset += chunk.encryptedSize
      decryptedBytes += plainPart.length
      onProgress?.(decryptProgress({
        stage: 'decrypting',
        part: chunk.chunkIndex + 1,
        totalParts: chunks.length,
        percent: Math.round((decryptedBytes / meta.originalSize) * 100),
      }))
    }
  } catch (error) {
    await cleanupPartialOutput(outputPath)
    throw error
  } finally {
    await fileHandle.close()
  }

  onProgress?.({ stage: 'complete', percent: 100 })
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

  if (usesChunkCompression(meta)) {
    if (meta.chunkCount !== 1) {
      throw new Error('Compressed multi-chunk files must be decrypted from a parts directory.')
    }

    const encryptedBuffer = await fs.readFile(encryptedFilePath)
    try {
      await writeDecryptedBuffer(encryptedBuffer, chunks, meta, tokenBytes, noncePrefix, outputPath, onProgress, signal)
    } catch (error) {
      await cleanupPartialOutput(outputPath)
      throw error
    }
    return
  }

  const stat = await fs.stat(encryptedFilePath)

  if (stat.size <= 64 * 1024 * 1024) {
    const encryptedBuffer = await fs.readFile(encryptedFilePath)
    try {
      await writeDecryptedBuffer(encryptedBuffer, chunks, meta, tokenBytes, noncePrefix, outputPath, onProgress, signal)
    } catch (error) {
      await cleanupPartialOutput(outputPath)
      throw error
    }
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

      const plainPart = await decryptPlainChunkFromEncrypted(
        encryptedChunk,
        tokenBytes,
        noncePrefix,
        chunk.chunkIndex,
        meta,
      )
      await outputHandle.write(plainPart)
      offset += chunk.encryptedSize
      decryptedBytes += plainPart.length
      onProgress?.(decryptProgress({
        stage: 'decrypting',
        part: chunk.chunkIndex + 1,
        totalParts: chunks.length,
        percent: Math.round((decryptedBytes / meta.originalSize) * 100),
      }))
    }
  } catch (error) {
    await cleanupPartialOutput(outputPath)
    throw error
  } finally {
    await fileHandle.close()
    await outputHandle.close()
  }

  onProgress?.({ stage: 'complete', percent: 100 })
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
      const plainPart = await decryptPlainChunkFromEncrypted(
        encryptedPart,
        tokenBytes,
        noncePrefix,
        chunk.chunkIndex,
        meta,
      )

      await fileHandle.write(plainPart)
      decryptedBytes += plainPart.length
      onProgress?.(decryptProgress({
        stage: 'decrypting',
        part: partNumber,
        totalParts: chunks.length,
        percent: Math.round((decryptedBytes / meta.originalSize) * 100),
      }))
    }
  } catch (error) {
    await cleanupPartialOutput(outputPath)
    throw error
  } finally {
    await fileHandle.close()
  }

  onProgress?.({ stage: 'complete', percent: 100 })
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

async function ensureOutputPath(outputPath, force) {
  try {
    const existing = await fs.stat(outputPath)
    if (existing.isDirectory()) {
      throw new Error(`Output path is a directory: ${outputPath}`)
    }
    if (!force) {
      throw new Error(`Output file already exists: ${outputPath} (use --force to overwrite)`)
    }
    await fs.unlink(outputPath)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }
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

  const hasCompleteLocalMeta = Boolean(resolvedOptions.inlineMeta || resolvedOptions.metaPath)

  const resolved = await resolveEncryptionMeta({
    metaPath: resolvedOptions.metaPath,
    inlineMeta: resolvedOptions.inlineMeta,
    linkToken: hasCompleteLocalMeta ? '' : linkToken,
    baseUrl: resolvedOptions.baseUrl || shareReference.baseUrl,
    signal: resolvedOptions.signal,
    onStatus: resolvedOptions.onStatus,
  })
  const meta = resolved.meta
  const linkInfo = resolved.linkInfo || null
  const encryptionToken = resolveEncryptionToken(
    resolvedOptions.encryptionToken,
    shareReference,
    linkToken,
  )
  const tokenBytes = importToken(encryptionToken)
  const noncePrefix = fromBase64Url(meta.noncePrefix)
  if (noncePrefix.length !== 8) {
    throw new Error('Invalid encryption metadata: noncePrefix must be 8 bytes.')
  }
  const originalName = linkInfo?.originalName || resolvedOptions.originalName || 'download'
  const outputName = sanitizeOutputName(resolvedOptions.output ? path.basename(resolvedOptions.output) : originalName)
  const outputPath = path.resolve(
    resolvedOptions.output || path.join(resolvedOptions.outputDirectory || process.cwd(), outputName),
  )

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await ensureOutputPath(outputPath, resolvedOptions.force)

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
  const reportStatus = (info) => {
    resolvedOptions.onStatus?.(info)
    resolvedOptions.onProgress?.(info)
  }
  const trimmedInput = String(input || '').trim()
  if (!trimmedInput) {
    throw new Error('Missing share URL, link token, or encrypted file path.')
  }

  const treatAsLocal = resolvedOptions.localFile
    || (!looksLikeRemoteInput(trimmedInput) && await pathExists(trimmedInput))

  if (treatAsLocal) {
    return decryptLocalFile(trimmedInput, {
      ...resolvedOptions,
      onProgress: reportStatus,
      onStatus: reportStatus,
    })
  }

  const parsed = parseDecryptInput(trimmedInput, {
    encryptionToken: resolvedOptions.encryptionToken,
    baseUrl: resolvedOptions.baseUrl,
  })

  const linkInfo = await fetchLinkInfo(parsed.baseUrl, parsed.linkToken, resolvedOptions.signal, reportStatus)

  if (linkInfo.status === 'expired') {
    throw new Error('This file link has expired.')
  }

  if (!linkInfo.clientEncrypted) {
    throw new Error('This link is not an encrypted file.')
  }

  let meta = resolvedOptions.inlineMeta
  if (!meta && resolvedOptions.metaPath) {
    meta = await readMetaFile(resolvedOptions.metaPath)
  }
  if (!meta) {
    meta = normalizeClientEncryptionMeta(linkInfo.clientEncryptionMeta)
  }
  if (!meta) {
    throw new Error('Invalid encryption metadata for this file.')
  }

  const tokenBytes = importToken(parsed.encryptionToken)
  const noncePrefix = fromBase64Url(meta.noncePrefix)
  if (noncePrefix.length !== 8) {
    throw new Error('Invalid encryption metadata: noncePrefix must be 8 bytes.')
  }
  const outputName = sanitizeOutputName(
    resolvedOptions.output ? path.basename(resolvedOptions.output) : linkInfo.originalName,
  )
  const outputPath = path.resolve(
    resolvedOptions.output || path.join(resolvedOptions.outputDirectory || process.cwd(), outputName),
  )

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await ensureOutputPath(outputPath, resolvedOptions.force)

  const useParts = linkInfo.storageMode === 'parts'
    || Number(linkInfo.partCount || 0) > 1

  if (useParts) {
    await decryptFromParts({
      baseUrl: parsed.baseUrl,
      linkToken: parsed.linkToken,
      meta,
      tokenBytes,
      noncePrefix,
      outputPath,
      onProgress: reportStatus,
      onStatus: reportStatus,
      signal: resolvedOptions.signal,
      concurrency: resolvedOptions.concurrency,
    })
  } else {
    const encryptedFileUrl = linkInfo.downloadUrl
      || linkInfo.encryptedFile
      || `${parsed.baseUrl}/f/${encodeURIComponent(parsed.linkToken)}`

    await decryptFromSingleFile({
      encryptedFileUrl,
      meta,
      tokenBytes,
      noncePrefix,
      outputPath,
      onProgress: reportStatus,
      onStatus: reportStatus,
      signal: resolvedOptions.signal,
      baseUrl: parsed.baseUrl,
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
