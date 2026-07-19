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
bytifi upload ./photo.png --api-key usk_your_api_key_here
bytifi upload ./photo.png --expires 60 --json
bytifi upload ./large.iso -q
```

### Decrypt

Download and decrypt a shared file locally, or decrypt a file you already downloaded from `/f/...`. No API key required.

```bash
# From share URL (downloads + decrypts)
bytifi decrypt 'https://bytifi.com/link?link=TOKEN#token=ENCRYPTION_TOKEN'
bytifi decrypt TOKEN --token ENCRYPTION_TOKEN -o ./restored-file.pdf

# From a downloaded encrypted file
bytifi decrypt ./downloaded.encrypted --link TOKEN --token ENCRYPTION_TOKEN
bytifi decrypt ./downloaded.encrypted --meta ./upload-meta.json --token ENCRYPTION_TOKEN
bytifi decrypt ./parts/ --link TOKEN --token ENCRYPTION_TOKEN
```

Use the full share URL (with `#token=...`) when possible. For `/f/...` downloads, pass the encryption token with `--token` and either `--link` (fetches metadata from the API) or `--meta` (saved `clientEncryptionMeta` JSON from upload `--json` output).

#### Offline decrypt workflow

Save metadata when you upload, so you can decrypt a downloaded `/f/...` file even after the link expires:

```bash
# 1. Upload and save the JSON output
bytifi upload ./report.pdf --json > upload.json

# 2. Download the encrypted file manually (browser, curl, etc.)
curl -L "$(jq -r .encryptedFile upload.json)" -o report.encrypted

# 3. Save metadata and decrypt locally (no API call needed)
jq -c .clientEncryptionMeta upload.json > report.meta.json
bytifi decrypt ./report.encrypted \
  --meta ./report.meta.json \
  --token "$(jq -r .encryptionToken upload.json)" \
  -o ./report.pdf
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
| `--base-url` | API base URL (default: `https://bytifi.com`) |

### Decrypt options

| Flag | Description |
|------|-------------|
| `--token` | Encryption token (required if not in URL `#token=...`) |
| `--link` | Link token for metadata when decrypting a local encrypted file |
| `--meta` | Saved `clientEncryptionMeta` JSON for offline local decrypt |
| `--share-url` | Share URL to read token/metadata while decrypting a local file |
| `-o, --output` | Output file path |
| `--output-dir` | Output directory when saving under the original filename |
| `--json` | Machine-readable JSON output |
| `-q, --quiet` | Print only the output file path |
| `--verbose` | Print error details to stderr |
| `--base-url` | API base URL (default: `https://bytifi.com`) |

Exit codes: `0` success, `1` usage error, `2` API error, `3` network error.

JSON output (`--json`) for upload includes `shareUrl`, `encryptedFile`, `encryptionToken`, `clientEncryptionMeta`, `expiresAt`, and `token`.

JSON output for decrypt includes `outputPath`, `originalName`, `size`, `mimeType`, `expiresAt`, `linkToken`, `storageMode`, and `sourcePath` (for local decrypt).

Files over ~100 MB encrypted use multipart upload automatically. Progress prints to stderr unless `--json` or `--quiet` is set.

## How it works

**Upload**

1. Encrypts the file locally with AES-GCM (same format as the website)
2. Uploads encrypted bytes via the public API (parallel part uploads for large files)
3. Prints a share URL including `#token=...`

**Decrypt**

1. Reads link metadata from `/api/link/:token`, or from a saved `--meta` JSON file
2. Downloads the encrypted file (single blob or per-part for large uploads), unless you pass a local encrypted file
3. Decrypts locally and writes the original file to disk

## Development

```bash
node bin/bytifi.js upload ./file.png --json
node bin/bytifi.js decrypt ./file.encrypted --meta ./meta.json --token '...'
```
