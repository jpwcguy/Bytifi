import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BytifiNetworkError, apiFetch } from '../lib/api.js'
import { createEncryptionContext, encryptChunkFromFile } from '../lib/crypto.js'
import {
  decryptFile,
  loadUploadJson,
  sanitizeOutputName,
  toExtendedLengthPath,
} from '../lib/decrypt.js'
import { buildResult } from '../lib/upload.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('sanitizeOutputName rewrites reserved Windows names and trailing dots', () => {
  assert.equal(sanitizeOutputName('CON'), 'CON_')
  assert.equal(sanitizeOutputName('con.txt'), 'con_.txt')
  assert.equal(sanitizeOutputName('report.txt.'), 'report.txt')
  assert.equal(sanitizeOutputName('report.txt '), 'report.txt')
  assert.equal(sanitizeOutputName('photo.png'), 'photo.png')
})

test('toExtendedLengthPath prefixes long Windows paths', () => {
  const longPath = `C:\\files\\${'a'.repeat(250)}.bin`
  assert.equal(toExtendedLengthPath('/tmp/bytifi-short', 'linux'), path.resolve('/tmp/bytifi-short'))
  assert.equal(toExtendedLengthPath(longPath, 'win32').startsWith('\\\\?\\'), true)
  assert.equal(toExtendedLengthPath('C:\\short.bin', 'win32'), 'C:\\short.bin')
})

test('loadUploadJson accepts a UTF-8 BOM', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bytifi-bom-'))
  const jsonPath = path.join(dir, 'upload.json')
  const context = createEncryptionContext({
    originalSize: 4,
    originalName: 'a.txt',
    mimeType: 'text/plain',
  })
  await fs.writeFile(jsonPath, `\ufeff${JSON.stringify({
    encryptionToken: context.token,
    clientEncryptionMeta: context.meta,
    link: 'abc',
  })}`)
  const parsed = await loadUploadJson(jsonPath)
  assert.equal(parsed.encryptionToken, context.token)
  assert.equal(parsed.linkToken, 'abc')
})

test('buildResult stores the API base URL', () => {
  const context = createEncryptionContext({ originalSize: 1, originalName: 'a.txt' })
  const result = buildResult({
    url: 'https://bytifi.com/link?link=abc',
    token: 'abc',
    downloadUrl: 'https://bytifi.com/f/abc/encrypted',
  }, context, 'https://bytifi.com/link?link=abc#token=key', 'https://files.example')
  assert.equal(result.baseUrl, 'https://files.example')
})

test('local decrypt writes a temp file and keeps the old output when decrypt fails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bytifi-decrypt-'))
  const plain = Buffer.from('hello bytifi local decrypt')
  const source = path.join(dir, 'plain.txt')
  await fs.writeFile(source, plain)
  const handle = await fs.open(source, 'r')
  const context = createEncryptionContext({
    originalSize: plain.length,
    originalName: 'plain.txt',
    mimeType: 'text/plain',
  })
  const encrypted = await encryptChunkFromFile(handle, 0, context)
  await handle.close()
  const encryptedPath = path.join(dir, 'file.encrypted')
  await fs.writeFile(encryptedPath, encrypted)
  const uploadJson = path.join(dir, 'upload.json')
  await fs.writeFile(uploadJson, JSON.stringify({
    link: 'abc',
    encryptionToken: context.token,
    clientEncryptionMeta: context.meta,
    originalName: 'plain.txt',
    baseUrl: 'https://example.test',
  }))
  const output = path.join(dir, 'restored.txt')
  const result = await decryptFile(encryptedPath, {
    uploadJsonPath: uploadJson,
    output,
    localFile: true,
  })
  assert.equal(result.outputPath, output)
  assert.equal(await fs.readFile(output, 'utf8'), plain.toString())

  await fs.writeFile(output, 'keep-me')
  const badJson = path.join(dir, 'bad.json')
  const other = createEncryptionContext({ originalSize: plain.length, originalName: 'plain.txt' })
  await fs.writeFile(badJson, JSON.stringify({
    link: 'abc',
    encryptionToken: other.token,
    clientEncryptionMeta: context.meta,
    originalName: 'plain.txt',
  }))
  await assert.rejects(() => decryptFile(encryptedPath, {
    uploadJsonPath: badJson,
    output,
    localFile: true,
    force: true,
  }))
  assert.equal(await fs.readFile(output, 'utf8'), 'keep-me')
})

test('local part decrypt streams parts into one file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bytifi-parts-'))
  const plain = Buffer.from('abcdefghijkl')
  const source = path.join(dir, 'plain.bin')
  await fs.writeFile(source, plain)
  const context = createEncryptionContext({
    originalSize: plain.length,
    originalName: 'plain.bin',
    mimeType: 'application/octet-stream',
    plainChunkSize: 8,
  })
  const handle = await fs.open(source, 'r')
  const partsDir = path.join(dir, 'parts')
  await fs.mkdir(partsDir)
  for (let index = 0; index < context.chunkCount; index += 1) {
    const encrypted = await encryptChunkFromFile(handle, index, context)
    await fs.writeFile(path.join(partsDir, `${index + 1}.part`), encrypted)
  }
  await handle.close()
  const uploadJson = path.join(dir, 'upload.json')
  await fs.writeFile(uploadJson, JSON.stringify({
    link: 'parts',
    encryptionToken: context.token,
    clientEncryptionMeta: context.meta,
    originalName: 'plain.bin',
  }))
  const output = path.join(dir, 'restored.bin')
  await decryptFile(partsDir, { uploadJsonPath: uploadJson, output, localFile: true })
  assert.deepEqual(await fs.readFile(output), plain)
})

test('expires and concurrency reject values that are not plain integers', () => {
  const expires = spawnSync(process.execPath, [path.join(root, 'bin/bytifi.js'), 'upload', 'file.bin', '--expires', '1.5e1'], {
    encoding: 'utf8',
  })
  assert.notEqual(expires.status, 0)
  assert.match(expires.stderr, /plain integer/)

  const concurrency = spawnSync(process.execPath, [path.join(root, 'bin/bytifi.js'), 'decrypt', 'file.bin', '--concurrency', '1.5'], {
    encoding: 'utf8',
  })
  assert.notEqual(concurrency.status, 0)
  assert.match(concurrency.stderr, /plain integer/)
})

test('apiFetch fails when the server does not answer before the timeout', async () => {
  const server = http.createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  try {
    await assert.rejects(
      () => apiFetch(`http://127.0.0.1:${port}`, '/hang', { timeoutMs: 50 }),
      (error) => error instanceof BytifiNetworkError && /timed out/.test(error.message),
    )
  } finally {
    server.close()
  }
})
