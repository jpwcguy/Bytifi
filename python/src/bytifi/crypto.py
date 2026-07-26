from __future__ import annotations

import gzip
import math
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .base64url import from_base64url, to_base64url

ENCRYPTED_PART_SIZE = 32 * 1024 * 1024
PLAIN_CHUNK_SIZE = ENCRYPTED_PART_SIZE - 16
MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024

_MIME_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".txt": "text/plain",
    ".json": "application/json",
    ".iso": "application/octet-stream",
}


def build_chunk_iv(nonce_prefix: bytes, chunk_index: int) -> bytes:
    iv = bytearray(12)
    iv[0:8] = nonce_prefix[0:8]
    iv[8:12] = chunk_index.to_bytes(4, "big")
    return bytes(iv)


def resolve_compression_mode(original_size: int = 0) -> str:
    if original_size > MULTIPART_THRESHOLD_BYTES:
        return "none"
    return "gzip"


def uses_chunk_compression(meta: dict) -> bool:
    compression = meta.get("compression") or {}
    return compression.get("algorithm") == "gzip"


def normalize_compression_meta(raw_compression: dict | None) -> dict:
    if not raw_compression or not isinstance(raw_compression, dict):
        return {"algorithm": "none", "scope": "chunk"}

    algorithm = str(raw_compression.get("algorithm", "none")).lower()
    if algorithm == "gzip":
        return {"algorithm": "gzip", "scope": "chunk"}
    return {"algorithm": "none", "scope": "chunk"}


def compress_plain_chunk(plain_chunk: bytes) -> bytes:
    return gzip.compress(plain_chunk)


def decompress_plain_chunk(compressed_chunk: bytes) -> bytes:
    return gzip.decompress(compressed_chunk)


def encrypt_chunk(payload_chunk: bytes, key: bytes, nonce_prefix: bytes, chunk_index: int) -> bytes:
    iv = build_chunk_iv(nonce_prefix, chunk_index)
    aesgcm = AESGCM(key)
    encrypted = aesgcm.encrypt(iv, payload_chunk, None)
    return encrypted


def decrypt_chunk(encrypted_chunk: bytes, key: bytes, nonce_prefix: bytes, chunk_index: int) -> bytes:
    if len(encrypted_chunk) < 16:
        raise ValueError("Encrypted chunk is too small.")
    iv = build_chunk_iv(nonce_prefix, chunk_index)
    aesgcm = AESGCM(key)
    return aesgcm.decrypt(iv, encrypted_chunk, None)


def decrypt_plain_chunk_from_encrypted(
    encrypted_chunk: bytes,
    key: bytes,
    nonce_prefix: bytes,
    chunk_index: int,
    meta: dict,
) -> bytes:
    payload = decrypt_chunk(encrypted_chunk, key, nonce_prefix, chunk_index)
    if not uses_chunk_compression(meta):
        return payload
    return decompress_plain_chunk(payload)


def build_client_encryption_meta(
    *,
    plain_chunk_size: int,
    chunk_count: int,
    nonce_prefix: bytes,
    original_size: int,
    mime_type: str,
    compression: str = "gzip",
) -> dict:
    compression_meta = (
        {"algorithm": "gzip", "scope": "chunk"}
        if compression == "gzip"
        else {"algorithm": "none", "scope": "chunk"}
    )
    return {
        "version": 2 if compression == "gzip" else 1,
        "algorithm": "AES-GCM",
        "compression": compression_meta,
        "chunkSize": plain_chunk_size,
        "chunkCount": chunk_count,
        "noncePrefix": to_base64url(nonce_prefix),
        "originalSize": original_size,
        "mimeType": mime_type or "application/octet-stream",
    }


def calculate_encrypted_size(original_size: int, plain_chunk_size: int = PLAIN_CHUNK_SIZE) -> tuple[int, int]:
    chunk_count = max(1, math.ceil(original_size / plain_chunk_size))
    encrypted_size = 0
    for chunk_index in range(chunk_count):
        start = chunk_index * plain_chunk_size
        plain_size = min(original_size - start, plain_chunk_size)
        encrypted_size += plain_size + 16
    return chunk_count, encrypted_size


@dataclass
class EncryptionContext:
    token: str
    token_bytes: bytes
    nonce_prefix: bytes
    meta: dict
    chunk_count: int
    encrypted_size: int
    original_name: str
    mime_type: str
    original_size: int
    plain_chunk_size: int
    compression: str


def create_encryption_context(
    *,
    original_size: int,
    original_name: str = "upload",
    mime_type: str = "application/octet-stream",
    token_bytes: bytes | None = None,
    nonce_prefix: bytes | None = None,
    plain_chunk_size: int = PLAIN_CHUNK_SIZE,
) -> EncryptionContext:
    token_bytes = token_bytes or secrets.token_bytes(32)
    nonce_prefix = nonce_prefix or secrets.token_bytes(8)

    if len(token_bytes) != 32:
        raise ValueError("Encryption token must be 32 bytes.")
    if len(nonce_prefix) != 8:
        raise ValueError("Nonce prefix must be 8 bytes.")

    compression = resolve_compression_mode(original_size)
    chunk_count, encrypted_size = calculate_encrypted_size(original_size, plain_chunk_size)
    meta = build_client_encryption_meta(
        plain_chunk_size=plain_chunk_size,
        chunk_count=chunk_count,
        nonce_prefix=nonce_prefix,
        original_size=original_size,
        mime_type=mime_type,
        compression=compression,
    )

    return EncryptionContext(
        token=to_base64url(token_bytes),
        token_bytes=token_bytes,
        nonce_prefix=nonce_prefix,
        meta=meta,
        chunk_count=chunk_count,
        encrypted_size=encrypted_size,
        original_name=original_name,
        mime_type=mime_type,
        original_size=original_size,
        plain_chunk_size=plain_chunk_size,
        compression=compression,
    )


def guess_mime_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    return _MIME_TYPES.get(ext, "application/octet-stream")


def resolve_upload_file(file_path: str | os.PathLike, *, mime_type: str | None = None) -> tuple[Path, EncryptionContext]:
    absolute_path = Path(file_path).resolve()
    if not absolute_path.is_file():
        raise ValueError("Upload path must be a file.")

    original_name = absolute_path.name
    resolved_mime = mime_type or guess_mime_type(original_name)
    context = create_encryption_context(
        original_size=absolute_path.stat().st_size,
        original_name=original_name,
        mime_type=resolved_mime,
    )
    return absolute_path, context


def read_plain_chunk(file_path: Path, chunk_index: int, original_size: int, plain_chunk_size: int) -> bytes:
    start = chunk_index * plain_chunk_size
    length = min(plain_chunk_size, original_size - start)
    with file_path.open("rb") as handle:
        handle.seek(start)
        data = handle.read(length)
    if len(data) != length:
        raise ValueError("File ended before the upload was complete.")
    return data


def encrypt_chunk_from_file(file_path: Path, chunk_index: int, context: EncryptionContext) -> bytes:
    plain_chunk = read_plain_chunk(file_path, chunk_index, context.original_size, context.plain_chunk_size)
    payload = compress_plain_chunk(plain_chunk) if context.compression == "gzip" else plain_chunk
    return encrypt_chunk(payload, context.token_bytes, context.nonce_prefix, chunk_index)


def import_token(token: str) -> bytes:
    token_bytes = from_base64url(token)
    if len(token_bytes) != 32:
        raise ValueError("Invalid encryption token length.")
    return token_bytes


def normalize_client_encryption_meta(raw_meta: dict | None) -> dict | None:
    if not raw_meta or not isinstance(raw_meta, dict):
        return None

    chunk_size = int(raw_meta.get("chunkSize", 0))
    chunk_count = int(raw_meta.get("chunkCount", 0))
    original_size = int(raw_meta.get("originalSize", -1))
    nonce_prefix = raw_meta.get("noncePrefix")

    if chunk_size <= 0 or chunk_count <= 0 or original_size < 0:
        return None
    if not isinstance(nonce_prefix, str) or not nonce_prefix:
        return None

    return {
        "version": int(raw_meta.get("version", 1)),
        "algorithm": str(raw_meta.get("algorithm", "AES-GCM")),
        "compression": normalize_compression_meta(raw_meta.get("compression")),
        "chunkSize": chunk_size,
        "chunkCount": chunk_count,
        "noncePrefix": nonce_prefix,
        "originalSize": original_size,
        "mimeType": str(raw_meta.get("mimeType", "application/octet-stream")),
    }


def build_encrypted_chunk_plan(meta: dict) -> dict:
    chunks = []
    offset = 0
    variable = uses_chunk_compression(meta)

    for chunk_index in range(meta["chunkCount"]):
        start = chunk_index * meta["chunkSize"]
        plain_size = min(meta["originalSize"] - start, meta["chunkSize"])
        encrypted_size = None if variable else plain_size + 16
        chunks.append(
            {
                "chunkIndex": chunk_index,
                "encryptedSize": encrypted_size,
                "plainSize": plain_size,
                "variableEncryptedSize": variable,
            }
        )
        offset += encrypted_size or 0

    return {
        "chunks": chunks,
        "totalEncryptedSize": None if variable else offset,
        "totalPlainSize": meta["originalSize"],
        "variableEncryptedSizes": variable,
    }
