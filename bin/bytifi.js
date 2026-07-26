#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'
import { decryptFile } from '../lib/decrypt.js'
import { createProgressTracker, formatProgressLine } from '../lib/progress.js'
import { validateBaseUrl } from '../lib/url.js'
import { BytifiApiError, BytifiNetworkError, uploadFile } from '../lib/upload.js'

const require = createRequire(import.meta.url)
const version =
  typeof __BYTIFI_VERSION__ !== 'undefined'
    ? __BYTIFI_VERSION__
    : require('../package.json').version

const SECRET_FLAGS = new Set(['--api-key', '-k', '--token'])

function printGlobalHelp() {
  process.stdout.write(`Bytifi CLI v${version} — encrypt, upload, and decrypt files

Usage:
  bytifi upload <file> [options]
  bytifi decrypt <input> [options]

Commands:
  upload    Encrypt and upload a file
  decrypt   Decrypt from a share link or local encrypted file

Global:
  -V, --version             Show version
  -h, --help                Show help

Run \`bytifi upload --help\` or \`bytifi decrypt --help\` for command options.

Exit codes:
  0   success
  1   usage or validation error
  2   API error (4xx/5xx response)
  3   network error
  130 interrupted (Ctrl+C)
`)
}

function printUploadHelp() {
  process.stdout.write(`Bytifi upload — encrypt and upload a file

Usage:
  bytifi upload <file> [options]

Options:
  -k, --api-key <key>       API key (default: BYTIFI_API_KEY env var)
  -e, --expires <minutes>   Link lifetime: 5|15|30|60|120 (default: 30)
      --delete-on-download  Remove file after first download
      --json                Print machine-readable JSON to stdout
  -q, --quiet               Print only the share URL
      --verbose             Show API error details on stderr
      --mime-type <type>    Override detected MIME type
      --concurrency <n>     Parallel part workers, 1–16 (default: auto)
      --base-url <url>      API base URL (default: https://bytifi.com)
  -h, --help                Show this help

Concurrency auto-scales by file size when --concurrency is omitted:
  ≤1 GB → 4 workers, 1–3 GB → 3 workers, ≥3 GB → 2 workers.

Examples:
  export BYTIFI_API_KEY=usk_your_key
  bytifi upload ./photo.png
  bytifi upload "./my report.pdf" --expires 60 --delete-on-download
  bytifi upload ./logs.txt --concurrency 8 --json > upload.json
  bytifi upload ./large.iso -q
`)
}

function printDecryptHelp() {
  process.stdout.write(`Bytifi decrypt — decrypt from a link or local encrypted file

Usage:
  bytifi decrypt <url-or-token|encrypted-file> [options]

Options:
      --token <token>       Encryption key from #token=... (not the link ID)
      --link <id>           Link ID from upload JSON "link" field (/f/LINK_ID)
      --upload-json <path>  Upload --json output (easiest for downloaded files)
      --meta <path>         Saved clientEncryptionMeta JSON (offline decrypt)
      --share-url <url>     Share URL for token/metadata when decrypting locally
      --local-file          Treat input as a local path even if it looks like a URL
  -o, --output <path>       Output file path (default: original filename)
      --output-dir <dir>    Directory for decrypted file (default: cwd)
      --force               Overwrite existing output file
      --concurrency <n>     Parallel download workers, 1–8 (default: 2)
      --json                Print machine-readable JSON to stdout
  -q, --quiet               Print only the output file path
      --verbose             Show error details on stderr
      --base-url <url>      API base URL (default: https://bytifi.com)
  -h, --help                Show this help

Examples:
  bytifi decrypt 'https://bytifi.com/link?link=LINK#token=KEY'
  bytifi decrypt ./downloaded.bin --upload-json upload.json -o ./restored.bin
  bytifi decrypt ./parts-dir/ --upload-json upload.json --force
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
    concurrency: null,
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

    if (arg === '--concurrency') {
      const raw = readFlagValue(argv, index, arg)
      const concurrency = Number(raw)
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
        throw new Error('concurrency must be an integer between 1 and 16.')
      }
      options.concurrency = concurrency
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
    localFile: false,
    force: false,
    concurrency: 2,
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

    if (arg === '--force') {
      options.force = true
      continue
    }

    if (arg === '--local-file') {
      options.localFile = true
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

    if (arg === '--concurrency') {
      const raw = readFlagValue(argv, index, arg)
      const concurrency = Number(raw)
      if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
        throw new Error('concurrency must be an integer between 1 and 8.')
      }
      options.concurrency = concurrency
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

function warnSecretFlags(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (SECRET_FLAGS.has(arg)) {
      process.stderr.write(
        `Warning: ${arg} on the command line may appear in shell history and process lists. Prefer BYTIFI_API_KEY for uploads.\n`,
      )
      return
    }
  }
}

function validateExpires(minutes) {
  const allowed = new Set([5, 15, 30, 60, 120])
  if (!allowed.has(minutes)) {
    throw new Error('expires must be one of: 5, 15, 30, 60, 120')
  }
}

function writeProgress(line) {
  if (line) {
    process.stderr.write(`\r${line}`)
  }
}

function finishProgressLine() {
  process.stderr.write('\n')
}

function clearProgressLine() {
  process.stderr.write('\r\x1b[K')
}

function createAbortContext(label) {
  const abortController = new AbortController()
  let abortedByUser = false

  const handleSignal = () => {
    abortedByUser = true
    abortController.abort()
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  return {
    signal: abortController.signal,
    cleanup() {
      process.off('SIGINT', handleSignal)
      process.off('SIGTERM', handleSignal)
    },
    checkAborted() {
      if (abortedByUser || abortController.signal.aborted) {
        clearProgressLine()
        process.stderr.write(`${label} aborted.\n`)
        process.exit(130)
      }
    },
  }
}

async function runUpload(filePath, options) {
  validateExpires(options.expiresInMinutes)
  options.baseUrl = validateBaseUrl(options.baseUrl)

  if (!options.apiKey) {
    throw new Error('Missing API key. Pass --api-key or set BYTIFI_API_KEY.')
  }

  const resolvedPath = path.resolve(filePath)
  const stat = await fs.stat(resolvedPath)

  if (!stat.isFile()) {
    throw new Error(`Upload path must be a file: ${resolvedPath}`)
  }

  const abort = createAbortContext('Upload')
  const showProgress = !options.quiet && !options.json
  const tracker = createProgressTracker()
  let lastLine = ''

  try {
    const result = await uploadFile(resolvedPath, {
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      expiresInMinutes: options.expiresInMinutes,
      deleteOnDownload: options.deleteOnDownload,
      mimeType: options.mimeType || undefined,
      concurrency: options.concurrency ?? undefined,
      signal: abort.signal,
      onProgress: showProgress
        ? (info) => {
            const enriched = tracker.update(info)
            const line = formatProgressLine(enriched)
            if (line && line !== lastLine) {
              lastLine = line
              writeProgress(line)
            }
          }
        : undefined,
    })

    abort.checkAborted()

    if (showProgress) {
      finishProgressLine()
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
  } catch (error) {
    abort.checkAborted()
    throw error
  } finally {
    abort.cleanup()
  }
}

async function runDecrypt(input, options) {
  options.baseUrl = validateBaseUrl(options.baseUrl)

  const abort = createAbortContext('Decrypt')
  const showProgress = !options.quiet && !options.json
  const tracker = createProgressTracker()
  let lastLine = ''

  try {
    const result = await decryptFile(input, {
      encryptionToken: options.encryptionToken,
      linkToken: options.linkToken,
      metaPath: options.metaPath,
      uploadJsonPath: options.uploadJsonPath,
      shareUrl: options.shareUrl,
      output: options.output || undefined,
      outputDirectory: options.outputDirectory || undefined,
      localFile: options.localFile,
      force: options.force,
      concurrency: options.concurrency,
      baseUrl: options.baseUrl,
      signal: abort.signal,
      onProgress: showProgress
        ? (info) => {
            const enriched = tracker.update(info)
            const line = formatProgressLine(enriched)
            if (line && line !== lastLine) {
              lastLine = line
              writeProgress(line)
            }
          }
        : undefined,
    })

    abort.checkAborted()

    if (showProgress) {
      finishProgressLine()
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
  } catch (error) {
    abort.checkAborted()
    throw error
  } finally {
    abort.cleanup()
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
  const argv = process.argv.slice(2)
  warnSecretFlags(argv)

  const [command, ...rest] = argv

  if (!command || command === '--help' || command === '-h') {
    printGlobalHelp()
    process.exit(0)
  }

  if (command === '--version' || command === '-V') {
    process.stdout.write(`${version}\n`)
    process.exit(0)
  }

  if (command === 'help') {
    printGlobalHelp()
    process.exit(0)
  }

  if (command === 'upload') {
    const { positional, options } = parseUploadArgs(rest)

    if (options.help) {
      printUploadHelp()
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
      printDecryptHelp()
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
      throw new Error(
        `Decrypt accepts one input at a time (got ${positional.length}). Quote paths with spaces.`,
      )
    }

    await runDecrypt(input, options)
    return
  }

  throw new Error(`Unknown command: ${command}`)
}

main().catch((error) => {
  clearProgressLine()
  finishProgressLine()
  const verbose = process.argv.includes('--verbose')
  printError(error, verbose)
  process.exit(exitCodeForError(error))
})
