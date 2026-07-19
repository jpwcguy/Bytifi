#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { BytifiApiError, BytifiNetworkError, uploadFile } from '../lib/upload.js'

function printHelp() {
  process.stdout.write(`Bytifi CLI — encrypt and upload files

Usage:
  bytifi upload <file> [options]

Options:
  -k, --api-key <key>     API key (default: BYTIFI_API_KEY env var)
  -e, --expires <minutes> Link lifetime: 5|15|30|60|120 (default: 30)
      --delete-on-download  Remove file after first download
      --json                Print machine-readable JSON to stdout
  -q, --quiet               Print only the share URL
      --mime-type <type>    Override detected MIME type
      --base-url <url>      API base URL (default: https://bytifi.com)
  -h, --help                Show this help

Examples:
  bytifi upload ./photo.png
  BYTIFI_API_KEY=usk_... bytifi upload report.pdf --expires 60 --json
`)
}

function parseArgs(argv) {
  const positional = []
  const options = {
    apiKey: process.env.BYTIFI_API_KEY || '',
    expiresInMinutes: 30,
    deleteOnDownload: false,
    json: false,
    quiet: false,
    mimeType: '',
    baseUrl: 'https://bytifi.com',
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]

    if (arg === '--help' || arg === '-h') {
      options.help = true
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

    if (arg === '--delete-on-download') {
      options.deleteOnDownload = true
      continue
    }

    if (arg === '--api-key' || arg === '-k') {
      options.apiKey = argv[index + 1] || ''
      index += 1
      continue
    }

    if (arg === '--expires' || arg === '-e') {
      options.expiresInMinutes = Number(argv[index + 1])
      index += 1
      continue
    }

    if (arg === '--mime-type') {
      options.mimeType = argv[index + 1] || ''
      index += 1
      continue
    }

    if (arg === '--base-url') {
      options.baseUrl = argv[index + 1] || options.baseUrl
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

async function runUpload(filePath, options) {
  validateExpires(options.expiresInMinutes)

  if (!options.apiKey) {
    throw new Error('Missing API key. Pass --api-key or set BYTIFI_API_KEY.')
  }

  const resolvedPath = path.resolve(filePath)
  await fs.access(resolvedPath)

  const result = await uploadFile(resolvedPath, {
    apiKey: options.apiKey,
    baseUrl: options.baseUrl,
    expiresInMinutes: options.expiresInMinutes,
    deleteOnDownload: options.deleteOnDownload,
    mimeType: options.mimeType || undefined,
    onProgress: options.quiet || options.json
      ? undefined
      : (percent) => {
          process.stderr.write(`Encrypting and uploading: ${percent}%\n`)
        },
  })

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }

  if (options.quiet) {
    process.stdout.write(`${result.shareUrl}\n`)
    return
  }

  process.stdout.write(`Share URL:\n${result.shareUrl}\n`)
  process.stdout.write(`Download URL:\n${result.downloadUrl}\n`)
  process.stdout.write(`Expires: ${result.expiresAt}\n`)
}

function exitCodeForError(error) {
  if (error instanceof BytifiNetworkError) return 3
  if (error instanceof BytifiApiError) return 2
  return 1
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)

  if (!command || command === '--help' || command === '-h') {
    printHelp()
    process.exit(0)
  }

  if (command !== 'upload') {
    if (command === 'help') {
      printHelp()
      process.exit(0)
    }

    throw new Error(`Unknown command: ${command}`)
  }

  const { positional, options } = parseArgs(rest)

  if (options.help) {
    printHelp()
    process.exit(0)
  }

  const filePath = positional[0]
  if (!filePath) {
    throw new Error('Missing file path. Usage: bytifi upload <file>')
  }

  await runUpload(filePath, options)
}

main().catch((error) => {
  process.stderr.write(`${error.message || 'Upload failed.'}\n`)
  process.exit(exitCodeForError(error))
})
