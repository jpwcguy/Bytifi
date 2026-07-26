import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compressPlainChunk,
  createEncryptionContext,
  decryptPlainChunkFromEncrypted,
  encryptChunk,
  importToken,
} from '../lib/crypto.js'
import { fromBase64Url, toBase64Url } from '../lib/base64url.js'

test('encrypt and decrypt round trip', async () => {
  const plain = Buffer.from('hello bytifi round trip test data')
  const context = createEncryptionContext({
    originalSize: plain.length,
    originalName: 'test.txt',
    mimeType: 'text/plain',
  })

  let payload = plain
  if (context.compression === 'gzip') {
    payload = await compressPlainChunk(plain)
  }

  const encrypted = encryptChunk(payload, context.tokenBytes, context.noncePrefix, 0)
  const tokenBytes = importToken(context.token)
  const decrypted = await decryptPlainChunkFromEncrypted(
    encrypted,
    tokenBytes,
    context.noncePrefix,
    0,
    context.meta,
  )

  assert.equal(decrypted.toString('utf8'), plain.toString('utf8'))
})

test('base64url token import matches context token bytes', () => {
  const context = createEncryptionContext({
    originalSize: 16,
    originalName: 'x.bin',
  })

  const imported = importToken(context.token)
  assert.deepEqual(imported, context.tokenBytes)
})

test('fromBase64Url round trips with toBase64Url', () => {
  const original = Buffer.from('round-trip-base64url')
  const encoded = toBase64Url(original)
  const decoded = fromBase64Url(encoded)
  assert.deepEqual(decoded, original)
})
