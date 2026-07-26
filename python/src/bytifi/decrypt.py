from __future__ import annotations

import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlparse, urlunparse

from .api import fetch_public_binary_with_retry, public_fetch_with_retry
from .base64url import from_base64url
from .crypto import (
    build_encrypted_chunk_plan,
    decrypt_plain_chunk_from_encrypted,
    import_token,
    normalize_client_encryption_meta,
    uses_chunk_compression,
)
from .url import normalize_base_url


def parse_decrypt_input(input_value: str, *, encryption_token: str = "", base_url: str | None = None) -> dict:
    trimmed = str(input_value or "").strip()
    if not trimmed:
        raise ValueError("Missing share URL or link token.")

    resolved_base_url = normalize_base_url(base_url)
    link_token = ""
    resolved_encryption_token = str(encryption_token or "").strip()

    if re.match(r"^https?://", trimmed, re.I) or trimmed.startswith("/"):
        url = urlparse(trimmed if re.match(r"^https?://", trimmed, re.I) else f"{resolved_base_url}{trimmed}")
        if url.scheme and url.netloc:
            resolved_base_url = f"{url.scheme}://{url.netloc}"

        fragment = url.fragment[1:] if url.fragment.startswith("#") else url.fragment
        for part in fragment.split("&"):
            if part.startswith("token=") and not resolved_encryption_token:
                resolved_encryption_token = part.split("=", 1)[1]

        from urllib.parse import parse_qs

        query = parse_qs(url.query)
        link_token = (query.get("link") or [""])[0]
        if not link_token:
            match = re.match(r"^/f/([^/]+)", url.path)
            link_token = match.group(1) if match else ""
    else:
        link_token = trimmed

    if not link_token:
        raise ValueError("Could not find a link token in the input URL.")
    if not resolved_encryption_token:
        raise ValueError(
            "Missing encryption token. Pass --token with the #token=... value from the share URL."
        )

    return {
        "baseUrl": resolved_base_url,
        "linkToken": link_token,
        "encryptionToken": resolved_encryption_token,
    }


def load_upload_json(upload_json_path: str | Path) -> dict:
    raw = Path(upload_json_path).read_text(encoding="utf-8")
    parsed = json.loads(raw)
    return {
        "linkToken": parsed.get("link") or parsed.get("token") or "",
        "encryptionToken": parsed.get("encryptionToken") or "",
        "clientEncryptionMeta": parsed.get("clientEncryptionMeta"),
        "baseUrl": normalize_base_url(parsed.get("baseUrl") or "https://bytifi.com"),
    }


def _fetch_link_info(base_url: str, link_token: str, on_status: Callable | None = None) -> dict:
    return public_fetch_with_retry(
        base_url,
        f"/api/link/{quote(link_token, safe='')}",
        on_status=on_status,
    )


def _sanitize_output_name(filename: str) -> str:
    base = Path(str(filename or "download").replace("\0", "").replace("\r", "").replace("\n", "")).name
    return base or "download"


def _decrypt_from_parts(
    *,
    base_url: str,
    link_token: str,
    meta: dict,
    token_bytes: bytes,
    nonce_prefix: bytes,
    output_path: Path,
    on_progress: Callable | None,
    on_status: Callable | None,
    concurrency: int = 2,
) -> None:
    plan = build_encrypted_chunk_plan(meta)
    chunks = plan["chunks"]
    worker_count = min(max(1, concurrency), len(chunks))
    results: list[bytes | None] = [None] * len(chunks)

    def process_part(index: int) -> tuple[int, bytes]:
        chunk = chunks[index]
        part_number = chunk["chunkIndex"] + 1
        on_progress and on_progress({"stage": "downloading", "part": part_number, "totalParts": len(chunks)})
        encrypted_part = fetch_public_binary_with_retry(
            base_url,
            f"/f/{quote(link_token, safe='')}/p/{part_number}",
            on_status=on_status,
        )
        plain_part = decrypt_plain_chunk_from_encrypted(
            encrypted_part,
            token_bytes,
            nonce_prefix,
            chunk["chunkIndex"],
            meta,
        )
        return index, plain_part

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(process_part, index) for index in range(len(chunks))]
        for future in as_completed(futures):
            index, plain_part = future.result()
            results[index] = plain_part

    with output_path.open("wb") as handle:
        for plain_part in results:
            assert plain_part is not None
            handle.write(plain_part)

    on_progress and on_progress({"stage": "complete", "percent": 100})


def _decrypt_from_single_file(
    *,
    encrypted_file_url: str,
    meta: dict,
    token_bytes: bytes,
    nonce_prefix: bytes,
    output_path: Path,
    base_url: str,
    on_progress: Callable | None,
    on_status: Callable | None,
) -> None:
    parsed = urlparse(encrypted_file_url if re.match(r"^https?://", encrypted_file_url, re.I) else f"{normalize_base_url(base_url)}{encrypted_file_url}")
    download_base = f"{parsed.scheme}://{parsed.netloc}"
    download_path = parsed.path + (f"?{parsed.query}" if parsed.query else "")

    encrypted_buffer = fetch_public_binary_with_retry(download_base, download_path, on_status=on_status)

    if uses_chunk_compression(meta):
        if meta["chunkCount"] != 1:
            raise ValueError("Compressed files with multiple chunks require part-based download.")
        plain_part = decrypt_plain_chunk_from_encrypted(encrypted_buffer, token_bytes, nonce_prefix, 0, meta)
        output_path.write_bytes(plain_part)
        on_progress and on_progress({"stage": "complete", "percent": 100})
        return

    plan = build_encrypted_chunk_plan(meta)
    offset = 0
    with output_path.open("wb") as handle:
        for chunk in plan["chunks"]:
            encrypted_size = chunk["encryptedSize"]
            encrypted_chunk = encrypted_buffer[offset:offset + encrypted_size]
            if len(encrypted_chunk) != encrypted_size:
                raise ValueError("Encrypted file ended before all parts were downloaded.")
            plain_part = decrypt_plain_chunk_from_encrypted(
                encrypted_chunk,
                token_bytes,
                nonce_prefix,
                chunk["chunkIndex"],
                meta,
            )
            handle.write(plain_part)
            offset += encrypted_size

    on_progress and on_progress({"stage": "complete", "percent": 100})


def decrypt_from_link(
    input_value: str,
    *,
    encryption_token: str = "",
    base_url: str | None = None,
    output_path: str | Path | None = None,
    upload_json_path: str | Path | None = None,
    force: bool = False,
    concurrency: int = 2,
    on_progress: Callable | None = None,
    on_status: Callable | None = None,
) -> Path:
    if upload_json_path:
        upload_json = load_upload_json(upload_json_path)
        parsed = {
            "baseUrl": upload_json["baseUrl"],
            "linkToken": upload_json["linkToken"],
            "encryptionToken": upload_json["encryptionToken"] or encryption_token,
        }
        inline_meta = normalize_client_encryption_meta(upload_json.get("clientEncryptionMeta"))
    else:
        parsed = parse_decrypt_input(input_value, encryption_token=encryption_token, base_url=base_url)
        inline_meta = None

    link_info = _fetch_link_info(parsed["baseUrl"], parsed["linkToken"], on_status=on_status)

    if link_info.get("status") == "expired":
        raise ValueError("This file link has expired.")
    if not link_info.get("clientEncrypted"):
        raise ValueError("This link is not an encrypted file.")

    meta = inline_meta or normalize_client_encryption_meta(link_info.get("clientEncryptionMeta"))
    if not meta:
        raise ValueError("Invalid encryption metadata for this file.")

    token_bytes = import_token(parsed["encryptionToken"])
    nonce_prefix = from_base64url(meta["noncePrefix"])

    original_name = _sanitize_output_name(link_info.get("originalName") or "download")
    resolved_output = Path(output_path) if output_path else Path.cwd() / original_name
    if resolved_output.exists() and not force:
        raise FileExistsError(f"Output file already exists: {resolved_output}")

    resolved_output.parent.mkdir(parents=True, exist_ok=True)

    storage_mode = link_info.get("storageMode") or "single"
    if storage_mode == "parts" or int(link_info.get("partCount") or 0) > 1:
        _decrypt_from_parts(
            base_url=parsed["baseUrl"],
            link_token=parsed["linkToken"],
            meta=meta,
            token_bytes=token_bytes,
            nonce_prefix=nonce_prefix,
            output_path=resolved_output,
            on_progress=on_progress,
            on_status=on_status,
            concurrency=concurrency,
        )
    else:
        encrypted_file_url = link_info.get("encryptedFile") or link_info.get("downloadUrl") or f"/f/{parsed['linkToken']}/encrypted"
        _decrypt_from_single_file(
            encrypted_file_url=encrypted_file_url,
            meta=meta,
            token_bytes=token_bytes,
            nonce_prefix=nonce_prefix,
            output_path=resolved_output,
            base_url=parsed["baseUrl"],
            on_progress=on_progress,
            on_status=on_status,
        )

    return resolved_output
