# Bytifi CLI

Official command-line tool for encrypting, uploading, and decrypting files with [Bytifi](https://bytifi.com).

## Install

### npm (all platforms)

```bash
npm install -g bytifi
```

Requires **Node.js 18+**.

Or from source:

```bash
git clone https://github.com/jpwcguy/Bytifi.git
cd Bytifi
npm link
```

### Windows (WinGet)

```powershell
winget install Bytifi.Bytifi
```

Or download [bytifi.exe from GitHub Releases](https://github.com/jpwcguy/Bytifi/releases/latest).

### Environment variable (all platforms)

```bash
export BYTIFI_API_KEY=usk_your_api_key_here
```

PowerShell:

```powershell
$env:BYTIFI_API_KEY = "usk_your_api_key_here"
```

Create an API key in **Account → API** on bytifi.com.

## Setup

Set your API key via environment variable (see Install above) or pass `--api-key` per command.
Prefer the environment variable — keys on the command line can appear in shell history and process lists.

## Usage

### Upload

```bash
bytifi upload ./photo.png
bytifi upload "./my video (1).mp4"
bytifi upload ./report.pdf --expires 60 --delete-on-download
bytifi upload ./logs.txt --compress auto --concurrency 8 --json > upload.json
bytifi upload ./photo.png -q
```

Files over **10 MB** use multipart upload automatically (lower memory use). Compression defaults to **`auto`**: gzip for text-like files, skipped for video/images/zip.

Upload accepts **one file at a time**. Quote paths that contain spaces. Avoid shell globs like `**` — your shell may expand them into dozens of paths.

### Decrypt from a link

Download and decrypt directly from a share URL or link token. No API key required.

```bash
bytifi decrypt 'https://bytifi.com/link?link=LINK_ID#token=ENCRYPTION_TOKEN'
bytifi decrypt LINK_ID --token ENCRYPTION_TOKEN -o ./restored.mp4
```

### Decrypt a downloaded encrypted file

If you already downloaded the encrypted blob from `/f/LINK_ID` (browser, curl, etc.):

```bash
# Easiest — use the upload JSON from when you uploaded
bytifi decrypt ./downloaded-file --upload-json upload.json

# Or pass both values manually
bytifi decrypt "./my video (1).mp4" \
  --link LINK_ID \
  --token ENCRYPTION_TOKEN
```

#### Link ID vs encryption token

Bytifi uses two different values — don't swap them:

| Name | Upload JSON field | Example location |
|------|-------------------|------------------|
| **Link ID** | `link` | `/f/QeVuslvdaP-okMxG`, `link?link=QeVuslvdaP-okMxG` |
| **Encryption token** | `encryptionToken` | `#token=2LTlmBrDkO4GJg0...` in `shareUrl` |

- `--link` = link ID (short, ~16 chars)
- `--token` = encryption key (long, ~43 chars)

### Offline decrypt workflow

Save metadata when you upload, so you can decrypt after the link expires:

```bash
bytifi upload ./report.pdf --json > upload.json
curl -L "$(jq -r .encryptedFile upload.json)" -o report.encrypted
bytifi decrypt ./report.encrypted --upload-json upload.json -o ./report.pdf
```

Without a global install:

```bash
npx bytifi upload ./photo.png --api-key usk_your_api_key_here
npm exec bytifi -- upload ./photo.png --api-key usk_your_api_key_here
```

Note: with `npm exec`, put `--` before the file path so npm does not swallow `--api-key`.

### Upload options

| Flag | Description |
|------|-------------|
| `-k, --api-key` | API key (default: `BYTIFI_API_KEY`) |
| `-e, --expires` | Link lifetime in minutes: `5`, `15`, `30`, `60`, `120` |
| `--delete-on-download` | Delete after first download |
| `--json` | Machine-readable JSON output |
| `-q, --quiet` | Print only the share URL |
| `--verbose` | Print API error details to stderr |
| `--mime-type` | Override detected MIME type |
| `--compress` | Compression mode: `auto`, `gzip`, or `off` (default: `auto`) |
| `--concurrency` | Parallel encrypt/upload workers, 1–16 (default: `4`) |
| `--base-url` | API base URL (default: `https://bytifi.com`) |

### Decrypt options

| Flag | Description |
|------|-------------|
| `--token` | Encryption key from `#token=...` (`encryptionToken` in upload JSON) |
| `--link` | Link ID from upload JSON `link` field (`/f/LINK_ID`) |
| `--upload-json` | Upload `--json` output file (recommended for downloaded files) |
| `--meta` | Saved `clientEncryptionMeta` JSON for offline decrypt |
| `--share-url` | Share URL to read token/metadata while decrypting a local file |
| `-o, --output` | Output file path |
| `--output-dir` | Output directory when saving under the original filename |
| `--json` | Machine-readable JSON output |
| `-q, --quiet` | Print only the output file path |
| `--verbose` | Print error details to stderr |
| `--base-url` | API base URL (default: `https://bytifi.com`) |

Exit codes: `0` success, `1` usage error, `2` API error, `3` network error.

JSON output (`--json`) for upload includes `shareUrl`, `encryptedFile`, `link`, `encryptionToken`, `clientEncryptionMeta`, `compression`, and `expiresAt`.

JSON output for decrypt includes `outputPath`, `originalName`, `size`, `mimeType`, `expiresAt`, `link`, `storageMode`, and `sourcePath` (for local decrypt).

Files over ~100 MB encrypted use multipart upload automatically. Progress prints to stderr unless `--json` or `--quiet` is set.

## How it works

**Upload**

1. Optionally gzip-compress each chunk (`--compress auto|gzip|off`)
2. Encrypts locally with AES-GCM (same format as the website, meta `version: 2` when compressed)
3. Uploads encrypted bytes via multipart pipeline for files >10 MB
4. Prints a share URL including `#token=...`

## Compatibility

| Scenario | Works? |
|----------|--------|
| Old links (no compression) | Yes — everywhere |
| New CLI upload + new CLI decrypt | Yes |
| New CLI upload + **updated website** decrypt | Yes — **deploy Bytifi-Website** after upgrading CLI |
| New CLI upload + old website (not deployed) | **Broken in browser** — garbled download |
| New CLI upload + old CLI (≤0.1.5) decrypt | **Broken** — upgrade CLI |
| Website upload (no compression) | Yes — unchanged |

Compressed files larger than one chunk use **part-based storage**; decrypt via share link or CLI part download.

**Decrypt**

1. Reads link metadata from `/api/link/:token`, from `--upload-json`, or from `--meta`
2. Downloads the encrypted file (unless you pass a local encrypted file)
3. Decrypts locally and writes the original file to disk

## Development

```bash
node bin/bytifi.js upload ./file.png --json > upload.json
node bin/bytifi.js decrypt ./file.encrypted --upload-json upload.json
```
