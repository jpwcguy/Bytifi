# Bytifi (Python)

Official Bytifi CLI for Python — encrypt, upload, and decrypt files with [bytifi.com](https://bytifi.com).

Published on [PyPI](https://pypi.org/project/bytifi/) as `bytifi`. Crypto and API behavior matches the Node.js npm package.

Requires **Python 3.10+**.

## Install

```bash
pip install bytifi
bytifi --version
```

### Upgrade

```bash
pip install --upgrade bytifi
```

### Verify which binary you are running

```bash
which bytifi
bytifi --version
```

If an old npm copy wins on `PATH`, upgrade it too:

```bash
npm install -g bytifi@latest
hash -r
```

## Setup

```bash
export BYTIFI_API_KEY=usk_your_api_key_here
```

Create an API key in **Account → API** on bytifi.com.

## Usage

```bash
bytifi upload ./photo.png
bytifi upload ./report.pdf --expires 60 --delete-on-download
bytifi upload ./logs.txt --json > upload.json
bytifi upload ./photo.png -q

bytifi decrypt 'https://bytifi.com/link?link=LINK#token=KEY' -o ./restored.png
bytifi decrypt LINK --token ENCRYPTION_TOKEN -o ./restored.png
bytifi decrypt ./file.encrypted --upload-json upload.json -o ./restored.bin
bytifi decrypt ./parts-dir --upload-json upload.json --output-dir ./out
```

A saved `upload.json` with `encryptionToken` and `clientEncryptionMeta` decrypts a local file without calling the API, including after the link has expired.

### Upload options

| Flag | Description |
|------|-------------|
| `-k, --api-key` | API key (default: `BYTIFI_API_KEY`) |
| `-e, --expires` | Link lifetime: `5`, `15`, `30`, `60`, `120` |
| `--delete-on-download` | Delete after first download |
| `--json` | Machine-readable JSON output |
| `-q, --quiet` | Print only the share URL |
| `--verbose` | Print API error details to stderr |
| `--mime-type` | Override detected MIME type |
| `--concurrency` | Parallel part workers, 1–16 |
| `--base-url` | API base URL (default: `https://bytifi.com`) |

### Decrypt options

| Flag | Description |
|------|-------------|
| `--token` | Encryption key from `#token=...` |
| `--link` | Link ID when it is not in the input |
| `--meta` | Encryption metadata JSON |
| `--upload-json` | Upload `--json` output file |
| `--share-url` | Share URL used with a local encrypted file |
| `--local-file` | Treat the input as a local path |
| `-o, --output` | Output file path |
| `--output-dir` | Directory for the decrypted file |
| `--json` | Machine-readable JSON output |
| `--force` | Overwrite existing output file |
| `--concurrency` | Parallel part download workers, 1–8 |
| `-q, --quiet` | Print only the output path |
| `--verbose` | Print error details to stderr |
| `--base-url` | API base URL (default: `https://bytifi.com`) |

`--json` and `--quiet` cannot be used together. Ctrl+C stops an upload or decrypt and exits with status 130.

**Library API:** see [`API.md`](API.md).

## Local secrets (home / repo)

Recreate local secrets on your PC from the examples (never commit the real files):

```bash
# API keys for the CLI
cp ../.env.example ../.env
# edit ../.env and set BYTIFI_API_KEY / PyPI tokens

# Optional: PyPI credentials in your home directory
cp ../.pypirc.example ~/.pypirc
chmod 600 ~/.pypirc
# edit ~/.pypirc and set your tokens
```

## Development

```bash
cd python
python -m venv .venv
```

macOS and Linux:

```bash
.venv/bin/pip install -e ".[dev]"
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python -m build
.venv/bin/bytifi --version
```

Windows:

```powershell
.venv\Scripts\pip install -e ".[dev]"
.venv\Scripts\python -m unittest discover -s tests -v
.venv\Scripts\python -m build
.venv\Scripts\bytifi --version
```

## Publishing

Set tokens in the repo root `.env` (see `.env.example`):

```env
PYPI_TEST_API_TOKEN=pypi-...
PYPI_API_TOKEN=pypi-...
```

**TestPyPI:**

```bash
./scripts/publish-testpypi.sh
```

**Production PyPI:**

```bash
./scripts/publish-pypi.sh
```

Install from TestPyPI:

```bash
pip install --index-url https://test.pypi.org/simple/ --extra-index-url https://pypi.org/simple/ bytifi
```
