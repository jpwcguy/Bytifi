import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fromBase64Url, toBase64Url } from './base64url.js'

export const ENCRYPTED_PART_SIZE = 32 * 1024 * 1024
export const PLAIN_CHUNK_SIZE = ENCRYPTED_PART_SIZE - 16
export const DIRECT_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024

export function buildChunkIv(noncePrefix, chunkIndex) {
  const iv = Buffer.alloc(12)
  noncePrefix.copy(iv, 0, 0, 8)
  iv.writeUInt32BE(chunkIndex, 8)
  return iv
}

export function encryptChunk(plainChunk, key, noncePrefix, chunkIndex) {
  const iv = buildChunkIv(noncePrefix, chunkIndex)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const encrypted = Buffer.concat([cipher.update(plainChunk), cipher.final()])
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
    version: 1,
    algorithm: 'AES-GCM',
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

  return encryptChunk(plainChunk, context.tokenBytes, context.noncePrefix, chunkIndex)
}

export async function collectEncryptedParts(filePath, context) {
  const fileHandle = await fs.open(filePath, 'r')
  const encryptedParts = []

  try {
    for (let chunkIndex = 0; chunkIndex < context.chunkCount; chunkIndex += 1) {
      encryptedParts.push(await encryptChunkFromFile(fileHandle, chunkIndex, context))
    }
  } finally {
    await fileHandle.close()
  }

  return encryptedParts
}

export async function encryptFileBuffer(fileBuffer, {
  originalName = 'upload',
  mimeType = 'application/octet-stream',
  tokenBytes = crypto.randomBytes(32),
  noncePrefix = crypto.randomBytes(8),
  plainChunkSize = PLAIN_CHUNK_SIZE,
} = {}) {
  const context = createEncryptionContext({
    originalSize: fileBuffer.length,
    originalName,
    mimeType,
    tokenBytes,
    noncePrefix,
    plainChunkSize,
  })

  const encryptedParts = []

  for (let chunkIndex = 0; chunkIndex < context.chunkCount; chunkIndex += 1) {
    const start = chunkIndex * plainChunkSize
    const end = Math.min(fileBuffer.length, start + plainChunkSize)
    const plainChunk = fileBuffer.subarray(start, end)
    encryptedParts.push(encryptChunk(plainChunk, context.tokenBytes, context.noncePrefix, chunkIndex))
  }

  return {
    ...context,
    encryptedParts,
    encryptedBuffer: Buffer.concat(encryptedParts),
  }
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

export function importToken(token) {
  const tokenBytes = fromBase64Url(token)
  if (tokenBytes.length !== 32) {
    throw new Error('Invalid encryption token length.')
  }
  return tokenBytes
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
