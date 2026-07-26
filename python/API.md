# Bytifi Python API

Use `bytifi` as a library in your Python code. Install with `pip install bytifi` (Python 3.10+).

## Quick start

```python
import os
from bytifi import upload_file, decrypt_from_link

result = upload_file(
    "photo.png",
    api_key=os.environ["BYTIFI_API_KEY"],
)

print(result["shareUrl"])
print(result["encryptionToken"])
print(result["link"])
```

```python
from pathlib import Path
from bytifi import decrypt_from_link

output = decrypt_from_link(
    "https://bytifi.com/link?link=LINK_ID#token=ENCRYPTION_TOKEN",
    output_path=Path("restored.png"),
)

print(output)  # Path to decrypted file
```

## Imports

```python
from bytifi import (
    # Upload / decrypt
    upload_file,
    decrypt_from_link,
    parse_decrypt_input,
    load_upload_json,

    # Errors
    BytifiApiError,
    BytifiNetworkError,

    # Crypto (advanced)
    EncryptionContext,
    create_encryption_context,
    resolve_upload_file,
    encrypt_chunk_from_file,
    import_token,
    normalize_client_encryption_meta,

    # Config
    normalize_base_url,
    validate_base_url,
    DEFAULT_BASE_URL,

    # Constants
    MULTIPART_THRESHOLD_BYTES,
    PLAIN_CHUNK_SIZE,
    ENCRYPTED_PART_SIZE,

    __version__,
)
```

## `upload_file`

Encrypt locally and upload to bytifi.com. Returns a dict with share URL, link ID, encryption token, and metadata.

```python
result = upload_file(
    "report.pdf",
    api_key="usk_your_key",
    base_url="https://bytifi.com",      # optional
    expires_in_minutes=30,              # 5, 15, 30, 60, or 120
    delete_on_download=False,
    mime_type=None,                     # auto-detected from filename
    concurrency=None,                   # multipart workers; auto if None
    on_progress=lambda info: print(info),
    on_status=lambda info: print(info),
)
```

**Result keys:** `shareUrl`, `url`, `encryptedFile`, `link`, `encryptionToken`, `clientEncryptionMeta`, `originalName`, `size`, `expiresAt`, `deleteOnDownload`, `clientEncrypted`, `compression`.

Files **≤ 10 MB** use a single gzip-compressed direct upload. Larger files use multipart upload (no gzip).

## `decrypt_from_link`

Download and decrypt from a share URL, link token, or upload JSON.

```python
# Full share URL (token in #fragment)
decrypt_from_link(
    "https://bytifi.com/link?link=abc123#token=xyz...",
    output_path="out.bin",
)

# Link + token separately
decrypt_from_link(
    "abc123",
    encryption_token="xyz...",
    output_path="out.bin",
)

# From saved upload JSON
decrypt_from_link(
    "downloaded.encrypted",
    upload_json_path="upload.json",
    output_path="original.pdf",
    force=True,
    concurrency=4,
)
```

## Parse helpers

```python
from bytifi import parse_decrypt_input, load_upload_json

parsed = parse_decrypt_input(
    "https://bytifi.com/link?link=LINK#token=KEY",
)
# {"baseUrl", "linkToken", "encryptionToken"}

meta = load_upload_json("upload.json")
# {"linkToken", "encryptionToken", "clientEncryptionMeta", "baseUrl"}
```

## Crypto (advanced)

Build encryption context without uploading — same format as the Node CLI and website.

```python
from pathlib import Path
from bytifi import create_encryption_context, encrypt_chunk_from_file

context = create_encryption_context(
    original_size=Path("file.bin").stat().st_size,
    original_name="file.bin",
    mime_type="application/octet-stream",
)

encrypted_part = encrypt_chunk_from_file(Path("file.bin"), 0, context)

print(context.token)       # share in URL #token=
print(context.meta)        # clientEncryptionMeta for the server
```

Decrypt a single encrypted chunk when you already have metadata and token bytes:

```python
from bytifi import (
    decrypt_plain_chunk_from_encrypted,
    from_base64url,
    import_token,
)

token_bytes = import_token(encryption_token)
nonce_prefix = from_base64url(meta["noncePrefix"])

plain = decrypt_plain_chunk_from_encrypted(
    encrypted_bytes,
    token_bytes,
    nonce_prefix,
    chunk_index=0,
    meta=meta,
)
```

## Errors

```python
from bytifi import BytifiApiError, BytifiNetworkError

try:
    upload_file("file.png", api_key=key)
except BytifiApiError as error:
    print(error.status, error.body)   # 4xx/5xx from API
except BytifiNetworkError as error:
    print(error)                      # connection / timeout
```

## Environment

```python
import os
from bytifi import upload_file

upload_file("file.png", api_key=os.environ["BYTIFI_API_KEY"])
```

Create an API key at **Account → API** on [bytifi.com](https://bytifi.com).

## CLI

The same package installs a `bytifi` terminal command:

```bash
bytifi upload ./photo.png
bytifi decrypt 'https://bytifi.com/link?link=LINK#token=KEY' -o ./out.png
```

See the [main README](../README.md) for CLI flags.
