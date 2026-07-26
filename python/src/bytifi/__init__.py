"""Official Bytifi SDK for Python — encrypt, upload, and decrypt with bytifi.com."""

from .api import BytifiApiError, BytifiNetworkError
from .crypto import (
    ENCRYPTED_PART_SIZE,
    MULTIPART_THRESHOLD_BYTES,
    PLAIN_CHUNK_SIZE,
    EncryptionContext,
    build_client_encryption_meta,
    create_encryption_context,
    decrypt_plain_chunk_from_encrypted,
    encrypt_chunk,
    encrypt_chunk_from_file,
    import_token,
    normalize_client_encryption_meta,
    resolve_upload_file,
)
from .base64url import from_base64url, to_base64url
from .decrypt import decrypt_from_link, load_upload_json, parse_decrypt_input
from .upload import upload_file
from .url import DEFAULT_BASE_URL, normalize_base_url, validate_base_url

__version__ = "0.2.10"

__all__ = [
    "DEFAULT_BASE_URL",
    "ENCRYPTED_PART_SIZE",
    "MULTIPART_THRESHOLD_BYTES",
    "PLAIN_CHUNK_SIZE",
    "BytifiApiError",
    "BytifiNetworkError",
    "EncryptionContext",
    "build_client_encryption_meta",
    "create_encryption_context",
    "decrypt_from_link",
    "decrypt_plain_chunk_from_encrypted",
    "encrypt_chunk",
    "encrypt_chunk_from_file",
    "from_base64url",
    "import_token",
    "load_upload_json",
    "normalize_base_url",
    "normalize_client_encryption_meta",
    "parse_decrypt_input",
    "resolve_upload_file",
    "to_base64url",
    "upload_file",
    "validate_base_url",
    "__version__",
]
