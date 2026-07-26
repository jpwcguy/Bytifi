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

### Python (PyPI)

Requires **Python 3.10+**.

```bash
pip install bytifi
bytifi --version
```

**Upgrade:**

```bash
pip install --upgrade bytifi
```

**Use in code:** see [`python/API.md`](python/API.md).

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

**Security:** Prefer `BYTIFI_API_KEY` over `--api-key` on the command line. API keys and encryption tokens passed as CLI flags may appear in shell history and process lists (`ps`). The CLI warns when secrets are passed on argv.

## Usage

### Upload

```bash
bytifi upload ./photo.png
bytifi upload "./my video (1).mp4"
bytifi upload ./report.pdf --expires 60 --delete-on-download
bytifi upload ./logs.txt --concurrency 8 --json > upload.json
bytifi upload ./photo.png -q
```

Files up to **10 MB** use a single direct upload with gzip-compressed chunks. Files **over 10 MB** use multipart upload with fixed-size encrypted parts (no compression — gzip can expand ISO/zip data past the server part limit).

Upload concurrency auto-scales when `--concurrency` is omitted: ≤1 GB → 4 workers, 1–3 GB → 3 workers, ≥3 GB → 2 workers.

Upload accepts **one file at a time**. Quote paths that contain spaces. Avoid shell globs like `**` — your shell may expand them into dozens of paths.

### Decrypt from a link

Download and decrypt directly from a share URL or link token. No API key required.

```bash
bytifi decrypt 'https://bytifi.com/link?link=LINK_ID#token=ENCRYPTION_TOKEN'
bytifi decrypt LINK_ID --token ENCRYPTION_TOKEN -o ./restored.mp4
bytifi decrypt LINK_ID --token ENCRYPTION_TOKEN --concurrency 4
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

# Force local-path mode when the filename looks like a URL
bytifi decrypt ./https-example.bin --local-file --upload-json upload.json

# Overwrite an existing output file
bytifi decrypt ./downloaded-file --upload-json upload.json --force
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
| `--concurrency` | Parallel encrypt/upload workers, 1–16 (default: auto-scaled by file size) |
| `--base-url` | API base URL (default: `https://bytifi.com`) |

### Decrypt options

| Flag | Description |
|------|-------------|
| `--token` | Encryption key from `#token=...` (`encryptionToken` in upload JSON) |
| `--link` | Link ID from upload JSON `link` field (`/f/LINK_ID`) |
| `--upload-json` | Upload `--json` output file (recommended for downloaded files) |
| `--meta` | Saved `clientEncryptionMeta` JSON for offline decrypt |
| `--share-url` | Share URL to read token/metadata while decrypting a local file |
| `--local-file` | Treat input as a local path even if it looks like a URL |
| `-o, --output` | Output file path |
| `--output-dir` | Output directory when saving under the original filename |
| `--force` | Overwrite existing output file |
| `--concurrency` | Parallel part download workers, 1–8 (default: `2`) |
| `--json` | Machine-readable JSON output |
| `-q, --quiet` | Print only the output file path |
| `--verbose` | Print error details to stderr |
| `--base-url` | API base URL (default: `https://bytifi.com`) |

Exit codes: `0` success, `1` usage error, `2` API error, `3` network error, `130` interrupted (Ctrl+C).

JSON output (`--json`) for upload includes `shareUrl`, `encryptedFile`, `link`, `encryptionToken`, `clientEncryptionMeta`, `compression`, and `expiresAt`.

JSON output for decrypt includes `outputPath`, `originalName`, `size`, `mimeType`, `expiresAt`, `link`, `storageMode`, and `sourcePath` (for local decrypt).

Progress prints to stderr with throughput and ETA unless `--json` or `--quiet` is set.

## Development

```bash
npm test
node bin/bytifi.js upload ./file.png --json > upload.json
node bin/bytifi.js decrypt ./file.encrypted --upload-json upload.json
```
