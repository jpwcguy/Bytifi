#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { decryptFile } from '../lib/decrypt.js'
import { BytifiApiError, BytifiNetworkError, uploadFile } from '../lib/upload.js'

const require = createRequire(import.meta.url)
const { version } = require('../package.json')

function printHelp() {
  process.stdout.write(`Bytifi CLI v${version} — encrypt, upload, and decrypt files

Usage:
  bytifi upload <file> [options]
  bytifi decrypt <url-or-token> [options]
  bytifi decrypt <encrypted-file> [options]

Upload options:
  -k, --api-key <key>       API key (default: BYTIFI_API_KEY env var)
  -e, --expires <minutes>   Link lifetime: 5|15|30|60|120 (default: 30)
      --delete-on-download  Remove file after first download
      --json                Print machine-readable JSON to stdout
  -q, --quiet               Print only the share URL
      --verbose             Show API error details on stderr
      --mime-type <type>    Override detected MIME type
      --base-url <url>      API base URL (default: https://bytifi.com)

Decrypt options:
      --token <token>       Encryption key from #token=... (not the link ID)
      --link <token>        Link ID from upload JSON "token" field (/f/TOKEN)
      --upload-json <path>  Upload --json output (easiest for downloaded files)
      --meta <path>         Saved clientEncryptionMeta JSON (offline decrypt)
      --share-url <url>     Share URL for token/metadata when decrypting a local file
  -o, --output <path>       Output file path (default: original filename)
      --output-dir <dir>    Directory for decrypted file (default: cwd)
      --json                Print machine-readable JSON to stdout
  -q, --quiet               Print only the output file path
      --verbose             Show error details on stderr
      --base-url <url>      API base URL (default: https://bytifi.com)

Global:
  -V, --version             Show version
  -h, --help                Show this help

Exit codes:
  0  success
  1  usage or validation error
  2  API error (4xx/5xx response)
  3  network error

Examples:
  bytifi upload ./photo.png
  bytifi upload ./video.mp4 --expires 60 --json > upload.json
  bytifi upload ./large.iso -q

  bytifi decrypt 'https://bytifi.com/link?link=abc#token=...'
  bytifi decrypt abc --token 'ENCRYPTION_TOKEN' -o ./restored.mp4

  bytifi decrypt ./downloaded.encrypted --upload-json upload.json
  bytifi decrypt "./my file(1).mp4" --link abc --token 'ENCRYPTION_TOKEN'
`)
}

function readFlagValue(argv, index, flagName) {
  const value = argv[index + 1]
  if (!value || value.startsWith('-')) {
    throw new Error(`Option ${flagName} requires a value.`)
  }
  return value
}

function parseUploadArgs(argv) {
  const positional = []
  const options = {
    apiKey: process.env.BYTIFI_API_KEY || '',
    expiresInMinutes: 30,
    deleteOnDownload: false,
    json: false,
    quiet: false,
    verbose: false,
    mimeType: '',
    baseUrl: 'https://bytifi.com',
    help: false,
    version: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    if (arg === '--version' || arg === '-V') {
      options.version = true
      continue
    }

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true
      continue
    }

    if (arg === '--verbose') {
      options.verbose = true
      continue
    }

    if (arg === '--delete-on-download') {
      options.deleteOnDownload = true
      continue
    }

    if (arg === '--api-key' || arg === '-k') {
      options.apiKey = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--expires' || arg === '-e') {
      const raw = readFlagValue(argv, index, arg)
      const minutes = Number(raw)
      if (!Number.isFinite(minutes)) {
        throw new Error(`Invalid expires value: ${raw}`)
      }
      options.expiresInMinutes = minutes
      index += 1
      continue
    }

    if (arg === '--mime-type') {
      options.mimeType = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--base-url') {
      options.baseUrl = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    positional.push(arg)
  }

  return { positional, options }
}

function parseDecryptArgs(argv) {
  const positional = []
  const options = {
    encryptionToken: '',
    linkToken: '',
    metaPath: '',
    uploadJsonPath: '',
    shareUrl: '',
    output: '',
    outputDirectory: '',
    json: false,
    quiet: false,
    verbose: false,
    baseUrl: 'https://bytifi.com',
    help: false,
    version: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
      continue
    }

    if (arg === '--version' || arg === '-V') {
      options.version = true
      continue
    }

    if (arg === '--json') {
      options.json = true
      continue
    }

    if (arg === '--quiet' || arg === '-q') {
      options.quiet = true
      continue
    }

    if (arg === '--verbose') {
      options.verbose = true
      continue
    }

    if (arg === '--token') {
      options.encryptionToken = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--link') {
      options.linkToken = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--meta') {
      options.metaPath = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--upload-json') {
      options.uploadJsonPath = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--share-url') {
      options.shareUrl = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--output' || arg === '-o') {
      options.output = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--output-dir') {
      options.outputDirectory = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg === '--base-url') {
      options.baseUrl = readFlagValue(argv, index, arg)
      index += 1
      continue
    }

    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`)
    }

    positional.push(arg)
  }

  return { positional, options }
}

function validateExpires(minutes) {
  const allowed = new Set([5, 15, 30, 60, 120])
  if (!allowed.has(minutes)) {
    throw new Error('expires must be one of: 5, 15, 30, 60, 120')
  }
}

function writeProgress(label, percent) {
  process.stderr.write(`\r${label}: ${percent}%`)
}

function clearProgressLine() {
  process.stderr.write('\r\x1b[K')
}

async function runUpload(filePath, options) {
  validateExpires(options.expiresInMinutes)

  if (!options.apiKey) {
    throw new Error('Missing API key. Pass --api-key or set BYTIFI_API_KEY.')
  }

  const resolvedPath = path.resolve(filePath)

  try {
    await fs.access(resolvedPath)
  } catch {
    throw new Error(`File not found or not readable: ${resolvedPath}`)
  }

  const abortController = new AbortController()

  const handleSignal = () => {
    abortController.abort()
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  const showProgress = !options.quiet && !options.json
  let lastPercent = -1

  try {
    const result = await uploadFile(resolvedPath, {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      expiresInMinutes: options.expiresInMinutes,
      deleteOnDownload: options.deleteOnDownload,
      mimeType: options.mimeType || undefined,
      signal: abortController.signal,
      onProgress: showProgress
        ? (percent) => {
            if (percent !== lastPercent) {
              lastPercent = percent
              writeProgress('Encrypting and uploading', percent)
            }
          }
        : undefined,
    })

    if (showProgress) {
      clearProgressLine()
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    if (options.quiet) {
      process.stdout.write(`${result.shareUrl}\n`)
      return
    }

    process.stdout.write(`Share URL:\n${result.shareUrl}\n`)
    process.stdout.write(`Encrypted file:\n${result.encryptedFile}\n`)
    process.stdout.write(`Expires: ${result.expiresAt}\n`)
  } finally {
    process.off('SIGINT', handleSignal)
    process.off('SIGTERM', handleSignal)
  }
}

async function runDecrypt(input, options) {
  const abortController = new AbortController()

  const handleSignal = () => {
    abortController.abort()
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  const showProgress = !options.quiet && !options.json
  let lastPercent = -1

  try {
    const result = await decryptFile(input, {
      encryptionToken: options.encryptionToken,
      linkToken: options.linkToken,
      metaPath: options.metaPath,
      uploadJsonPath: options.uploadJsonPath,
      shareUrl: options.shareUrl,
      output: options.output || undefined,
      outputDirectory: options.outputDirectory || undefined,
      baseUrl: options.baseUrl,
      signal: abortController.signal,
      onProgress: showProgress
        ? (percent) => {
            if (percent !== lastPercent) {
              lastPercent = percent
              writeProgress('Downloading and decrypting', percent)
            }
          }
        : undefined,
    })

    if (showProgress) {
      clearProgressLine()
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return
    }

    if (options.quiet) {
      process.stdout.write(`${result.outputPath}\n`)
      return
    }

    process.stdout.write(`Saved: ${result.outputPath}\n`)
    process.stdout.write(`Original name: ${result.originalName}\n`)
    process.stdout.write(`Expires: ${result.expiresAt}\n`)
  } finally {
    process.off('SIGINT', handleSignal)
    process.off('SIGTERM', handleSignal)
  }
}

function exitCodeForError(error) {
  if (error instanceof BytifiNetworkError) return 3
  if (error instanceof BytifiApiError) return 2
  return 1
}

function printError(error, verbose) {
  process.stderr.write(`${error.message || 'Command failed.'}\n`)

  if (!verbose) return

  if (error instanceof BytifiApiError) {
    if (error.status) {
      process.stderr.write(`HTTP ${error.status}\n`)
    }
    if (error.body) {
      process.stderr.write(`${JSON.stringify(error.body, null, 2)}\n`)
    }
  }

  if (error instanceof BytifiNetworkError && error.cause) {
    process.stderr.write(`${error.cause}\n`)
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === '--help' || command === '-h') {
    printHelp()
    process.exit(0)
  }

  if (command === '--version' || command === '-V') {
    process.stdout.write(`${version}\n`)
    process.exit(0)
  }

  if (command === 'help') {
    printHelp()
    process.exit(0)
  }

  if (command === 'upload') {
    const { positional, options } = parseUploadArgs(rest)

    if (options.help) {
      printHelp()
      process.exit(0)
    }

    if (options.version) {
      process.stdout.write(`${version}\n`)
      process.exit(0)
    }

    if (options.json && options.quiet) {
      throw new Error('Use either --json or --quiet, not both.')
    }

    const filePath = positional[0]
    if (!filePath) {
      throw new Error('Missing file path. Usage: bytifi upload <file>')
    }

    if (positional.length > 1) {
      throw new Error(
        `Upload accepts one file at a time (got ${positional.length}). Quote paths with spaces and avoid shell globs like **.`,
      )
    }

    await runUpload(filePath, options)
    return
  }

  if (command === 'decrypt') {
    const { positional, options } = parseDecryptArgs(rest)

    if (options.help) {
      printHelp()
      process.exit(0)
    }

    if (options.version) {
      process.stdout.write(`${version}\n`)
      process.exit(0)
    }

    if (options.json && options.quiet) {
      throw new Error('Use either --json or --quiet, not both.')
    }

    const input = positional[0]
    if (!input) {
      throw new Error('Missing input. Usage: bytifi decrypt <url-or-token|encrypted-file>')
    }

    if (positional.length > 1) {
      process.stderr.write(`Warning: ignoring extra arguments: ${positional.slice(1).join(', ')}\n`)
    }

    await runDecrypt(input, options)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  clearProgressLine()
  const verbose = process.argv.includes('--verbose')
  printError(error, verbose)
  process.exit(exitCodeForError(error))
})
