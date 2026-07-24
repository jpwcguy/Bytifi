import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { promisify } from 'node:util'
import { fromBase64Url, toBase64Url } from './base64url.js'

const gzipAsync = promisify(zlib.gzip)
const gunzipAsync = promisify(zlib.gunzip)

export const ENCRYPTED_PART_SIZE = 32 * 1024 * 1024
export const PLAIN_CHUNK_SIZE = ENCRYPTED_PART_SIZE - 16
export const DIRECT_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024
export const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024

export function buildChunkIv(noncePrefix, chunkIndex) {
  const iv = Buffer.alloc(12)
  noncePrefix.copy(iv, 0, 0, 8)
  iv.writeUInt32BE(chunkIndex, 8)
  return iv
}

export function resolveCompressionMode() {
  return 'gzip'
}

export function usesChunkCompression(meta) {
  return meta?.compression?.algorithm === 'gzip'
}

export function normalizeCompressionMeta(rawCompression) {
  if (!rawCompression || typeof rawCompression !== 'object') {
    return { algorithm: 'none', scope: 'chunk' }
  }

  const algorithm = String(rawCompression.algorithm || 'none').toLowerCase()
  if (algorithm === 'gzip') {
    return { algorithm: 'gzip', scope: 'chunk' }
  }

  return { algorithm: 'none', scope: 'chunk' }
}

export async function compressPlainChunk(plainChunk) {
  return gzipAsync(plainChunk)
}

export async function decompressPlainChunk(compressedChunk) {
  return gunzipAsync(compressedChunk)
}

export function encryptChunk(payloadChunk, key, noncePrefix, chunkIndex) {
  const iv = buildChunkIv(noncePrefix, chunkIndex)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(payloadChunk), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([encrypted, tag])
}

export function buildClientEncryptionMeta({
  plainChunkSize,
  chunkCount,
  noncePrefix,
  originalSize,
  mimeType,
}) {
  return {
    version: 2,
    algorithm: 'AES-GCM',
    compression: { algorithm: 'gzip', scope: 'chunk' },
    chunkSize: plainChunkSize,
    chunkCount,
    noncePrefix: toBase64Url(noncePrefix),
    originalSize,
    mimeType: mimeType || 'application/octet-stream',
  }
}

export function calculateEncryptedSize(originalSize, plainChunkSize = PLAIN_CHUNK_SIZE) {
  const chunkCount = Math.ceil(originalSize / plainChunkSize) || 1
  let encryptedSize = 0

  for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
    const start = chunkIndex * plainChunkSize
    const plainSize = Math.min(originalSize - start, plainChunkSize)
    encryptedSize += plainSize + 16
  }

  return { chunkCount, encryptedSize }
}

export function createEncryptionContext({
  originalSize,
  originalName = 'upload',
  mimeType = 'application/octet-stream',
  tokenBytes = crypto.randomBytes(32),
  noncePrefix = crypto.randomBytes(8),
  plainChunkSize = PLAIN_CHUNK_SIZE,
}) {
  if (tokenBytes.length !== 32) throw new Error('Encryption token must be 32 bytes.')
  if (noncePrefix.length !== 8) throw new Error('Nonce prefix must be 8 bytes.')

  const { chunkCount, encryptedSize } = calculateEncryptedSize(originalSize, plainChunkSize)
  const meta = buildClientEncryptionMeta({
    plainChunkSize,
    chunkCount,
    noncePrefix,
    originalSize,
    mimeType,
  })

  return {
    token: toBase64Url(tokenBytes),
    tokenBytes,
    noncePrefix,
    meta,
    chunkCount,
    encryptedSize,
    originalName,
    mimeType,
    originalSize,
    plainChunkSize,
    compression: 'gzip',
  }
}

export async function resolveUploadFile(filePath, options = {}) {
  const absolutePath = path.resolve(filePath)
  const stat = await fs.stat(absolutePath)

  if (!stat.isFile()) {
    throw new Error('Upload path must be a file.')
  }

  const originalName = options.originalName || path.basename(absolutePath)
  const mimeType = options.mimeType || guessMimeType(originalName)

  return {
    absolutePath,
    context: createEncryptionContext({
      originalSize: stat.size,
      originalName,
      mimeType,
    }),
  }
}

async function readPlainChunk(fileHandle, chunkIndex, originalSize, plainChunkSize = PLAIN_CHUNK_SIZE) {
  const start = chunkIndex * plainChunkSize
  const length = Math.min(plainChunkSize, originalSize - start)
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await fileHandle.read(buffer, 0, length, start)

  if (bytesRead !== length) {
    throw new Error('File ended before the upload was complete.')
  }

  return buffer
}

export async function encryptChunkFromFile(fileHandle, chunkIndex, context) {
  const plainChunk = await readPlainChunk(
    fileHandle,
    chunkIndex,
    context.originalSize,
    context.plainChunkSize,
  )

  let payload = await compressPlainChunk(plainChunk)

  return encryptChunk(payload, context.tokenBytes, context.noncePrefix, chunkIndex)
}

export function decryptChunk(encryptedChunk, tokenBytes, noncePrefix, chunkIndex) {
  if (encryptedChunk.length < 16) {
    throw new Error('Encrypted chunk is too small.')
  }

  const iv = buildChunkIv(noncePrefix, chunkIndex)
  const ciphertext = encryptedChunk.subarray(0, encryptedChunk.length - 16)
  const tag = encryptedChunk.subarray(encryptedChunk.length - 16)
  const decipher = crypto.createDecipheriv('aes-256-gcm', tokenBytes, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export async function decryptPlainChunkFromEncrypted(encryptedChunk, tokenBytes, noncePrefix, chunkIndex, meta) {
  const payload = decryptChunk(encryptedChunk, tokenBytes, noncePrefix, chunkIndex)

  if (!usesChunkCompression(meta)) {
    return payload
  }

  return decompressPlainChunk(payload)
}

export function importToken(token) {
  const tokenBytes = fromBase64Url(token)
  if (tokenBytes.length !== 32) {
    throw new Error('Invalid encryption token length.')
  }
  return tokenBytes
}

export function normalizeClientEncryptionMeta(rawMeta) {
  if (!rawMeta || typeof rawMeta !== 'object') return null

  const chunkSize = Number(rawMeta.chunkSize)
  const chunkCount = Number(rawMeta.chunkCount)
  const originalSize = Number(rawMeta.originalSize)

  if (!Number.isFinite(chunkSize) || chunkSize <= 0) return null
  if (!Number.isFinite(chunkCount) || chunkCount <= 0) return null
  if (!Number.isFinite(originalSize) || originalSize < 0) return null
  if (typeof rawMeta.noncePrefix !== 'string' || !rawMeta.noncePrefix) return null

  return {
    version: Number(rawMeta.version) || 1,
    algorithm: String(rawMeta.algorithm || 'AES-GCM'),
    compression: normalizeCompressionMeta(rawMeta.compression),
    chunkSize,
    chunkCount,
    noncePrefix: rawMeta.noncePrefix,
    originalSize,
    mimeType: String(rawMeta.mimeType || 'application/octet-stream'),
  }
}

export function buildEncryptedChunkPlan(meta) {
  const chunks = []
  let offset = 0
  const variableEncryptedSizes = usesChunkCompression(meta)

  for (let chunkIndex = 0; chunkIndex < meta.chunkCount; chunkIndex += 1) {
    const start = chunkIndex * meta.chunkSize
    const plainSize = Math.min(meta.originalSize - start, meta.chunkSize)
    const encryptedSize = variableEncryptedSizes ? null : plainSize + 16

    chunks.push({ chunkIndex, encryptedSize, plainSize, variableEncryptedSize: variableEncryptedSizes })
    offset += encryptedSize || 0
  }

  return {
    chunks,
    totalEncryptedSize: variableEncryptedSizes ? null : offset,
    totalPlainSize: meta.originalSize,
    variableEncryptedSizes,
  }
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase()
  const map = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.iso': 'application/octet-stream',
  }
  return map[ext] || 'application/octet-stream'
}
