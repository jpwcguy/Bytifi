# Bytifi CLI

Official command-line tool for encrypting and uploading files to [Bytifi](https://bytifi.com).

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

```bash
bytifi upload ./photo.png
bytifi upload ./photo.png --api-key usk_your_api_key_here
bytifi upload ./photo.png --expires 60 --json
bytifi upload ./large.iso -q
```

Without a global install:

```bash
npx bytifi upload ./photo.png --api-key usk_your_api_key_here
npm exec bytifi -- upload ./photo.png --api-key usk_your_api_key_here
```

Note: with `npm exec`, put `--` before the file path so npm does not swallow `--api-key`.

### Options

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

Exit codes: `0` success, `1` usage error, `2` API error, `3` network error.

JSON output (`--json`) includes `shareUrl`, `downloadUrl`, `encryptionToken`, `expiresAt`, and `token`.

Files over ~100 MB encrypted use multipart upload automatically. Progress prints to stderr unless `--json` or `--quiet` is set.

## How it works

1. Encrypts the file locally with AES-GCM (same format as the website)
2. Uploads encrypted bytes via the public API (parallel part uploads for large files)
3. Prints a share URL including `#token=...`

## Development

```bash
node bin/bytifi.js upload ./file.png --json
```
