# Changelog

All notable changes to the Bytifi CLI are documented here.

## 0.2.12 — 2026-08-04

### Fixed
- Multipart uploads no longer pass `undefined` into `AbortSignal.any` when no caller signal is provided
- Multipart session abort on failure no longer reuses an already-aborted signal (so Ctrl+C cleanup can reach the API)
- Successful upload/decrypt results are printed even if SIGINT arrives after the operation finishes
- Remote decrypt uses multipart when `partCount > 1`, even if `storageMode` is missing
- `RateLimit-Reset` values in Unix milliseconds no longer cause multi-year sleeps (Node + Python)
- Decrypt rejects output paths that are directories and validates `noncePrefix` length
- Python multipart upload cancels sibling part workers before aborting the session on failure

## 0.2.11 — 2026-08-04

### Fixed
- Windows `bytifi.exe` (pkg) no longer crashes on startup with `createRequire(... Received undefined)` when `import.meta.url` is empty inside the CJS snapshot. Version is injected at bundle time and the `createRequire` fallback is stripped from the Windows build.

## 0.2.8 — 2026-07-26

### Fixed
- Direct uploads with gzip compression now send `encryptedSize` in metadata so the server accepts the compressed ciphertext size.

## 0.2.7 — 2026-07-26

### Added
- Extracted shared HTTP layer (`lib/api.js`) and URL helpers (`lib/url.js`)
- `--force` flag for decrypt to overwrite existing output files
- `--local-file` flag to force local-path decrypt mode
- `--concurrency` flag for decrypt (default: 2 parallel part downloads)
- Throughput and ETA in progress output via `createProgressTracker()`
- Subcommand-specific `--help` (`bytifi upload --help`, `bytifi decrypt --help`)
- `node:test` suite for crypto round-trip, URL validation, and progress formatting
- MIT `LICENSE` file

### Fixed
- Multipart upload aborts session on any worker failure (shared abort controller)
- Upload part requests include `X-Upload-Session` header
- Progress percentage accounts for in-flight multipart parts
- Decrypt cleans up partial output files on failure
- Decrypt skips API metadata fetch when `--meta` or `--upload-json` provides complete meta
- Base64url decode validates charset before decoding
- README documents 10 MB multipart threshold (not 100 MB)
- Upload validates path is a regular file; decrypt rejects extra positional args
- SIGINT/SIGTERM exit code 130 with clear abort message
- Warnings when `--api-key` or `--token` appear on the command line

### Changed
- Bumped version to 0.2.7; added `npm test` and `prepublishOnly` hook
- Removed unused `DIRECT_UPLOAD_LIMIT_BYTES` export from `lib/crypto.js`
