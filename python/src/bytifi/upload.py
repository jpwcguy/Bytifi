from __future__ import annotations

import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from .api import UNLIMITED_RATE_LIMIT_RETRIES, api_fetch_with_retry
from .crypto import (
    MULTIPART_THRESHOLD_BYTES,
    EncryptionContext,
    encrypt_chunk_from_file,
    resolve_upload_file,
)

DEFAULT_CONCURRENCY = 4
POLL_INTERVAL_MS = 1500
POLL_TIMEOUT_MS = 30 * 60 * 1000


def _build_share_url(payload: dict, encryption_token: str) -> str:
    return f"{payload['url']}#token={quote(encryption_token, safe='')}"


def _build_result(payload: dict, context: EncryptionContext, share_url: str) -> dict:
    return {
        "shareUrl": share_url,
        "url": payload["url"],
        "encryptedFile": payload.get("downloadUrl"),
        "link": payload["token"],
        "encryptionToken": context.token,
        "clientEncryptionMeta": context.meta,
        "originalName": payload.get("originalName") or context.original_name,
        "size": payload.get("size"),
        "expiresAt": payload.get("expiresAt"),
        "deleteOnDownload": payload.get("deleteOnDownload"),
        "clientEncrypted": payload.get("clientEncrypted"),
        "compression": context.compression,
    }


def _upload_progress_percent(completed_parts: int, in_flight_parts: int, total_parts: int) -> int:
    weighted = completed_parts + in_flight_parts * 0.5
    return min(100, round((weighted / total_parts) * 100))


def _collect_encrypted_buffer(
    file_path: Path,
    context: EncryptionContext,
    *,
    on_progress: Callable[[dict], None] | None = None,
) -> bytes:
    encrypted_parts: list[bytes] = []
    for chunk_index in range(context.chunk_count):
        on_progress and on_progress({
            "stage": "encrypting",
            "part": chunk_index + 1,
            "totalParts": context.chunk_count,
            "percent": round((chunk_index / context.chunk_count) * 90),
        })
        encrypted_parts.append(encrypt_chunk_from_file(file_path, chunk_index, context))
        on_progress and on_progress({
            "stage": "encrypted",
            "part": chunk_index + 1,
            "totalParts": context.chunk_count,
            "percent": round(((chunk_index + 1) / context.chunk_count) * 90),
        })

    on_progress and on_progress({"stage": "uploading", "percent": 95, "detail": "direct upload"})
    return b"".join(encrypted_parts)


def _upload_direct(
    context: EncryptionContext,
    encrypted_buffer: bytes,
    *,
    api_key: str,
    base_url: str,
    expires_in_minutes: int,
    delete_on_download: bool,
    on_progress: Callable[[dict], None] | None,
    on_status: Callable[[dict], None] | None,
) -> dict:
    client_encryption_meta = {**context.meta, "encryptedSize": len(encrypted_buffer)}

    payload = api_fetch_with_retry(
        base_url,
        "/api/public/upload",
        api_key=api_key,
        method="POST",
        data={
            "clientEncrypted": "true",
            "clientEncryptionMeta": json.dumps(client_encryption_meta),
            "deleteOnDownload": "true" if delete_on_download else "false",
            "expiresInMinutes": str(expires_in_minutes),
        },
        files={
            "file": (context.original_name, encrypted_buffer, "application/octet-stream"),
        },
        on_status=on_status,
        rate_limit_retries=UNLIMITED_RATE_LIMIT_RETRIES,
    )

    on_progress and on_progress({"stage": "complete", "percent": 100})
    share_url = _build_share_url(payload, context.token)
    return _build_result(payload, context, share_url)


def _poll_upload_status(
    session_token: str,
    *,
    api_key: str,
    base_url: str,
    on_status: Callable[[dict], None] | None,
) -> dict:
    started_at = time.time()
    while True:
        if (time.time() - started_at) * 1000 > POLL_TIMEOUT_MS:
            raise TimeoutError("Upload finalization timed out. Try again later.")

        payload = api_fetch_with_retry(
            base_url,
            f"/api/public/upload/status?sessionToken={quote(session_token, safe='')}",
            api_key=api_key,
            on_status=on_status,
            rate_limit_retries=UNLIMITED_RATE_LIMIT_RETRIES,
        )

        if payload.get("status") not in ("processing", "pending"):
            return payload

        progress = payload.get("progress") or {}
        on_status and on_status({
            "stage": "finalizing",
            "percent": min(99, round(float(progress.get("percent") or 0))),
            "detail": progress.get("phase") or "processing on server",
        })
        time.sleep(POLL_INTERVAL_MS / 1000)


def _resolve_upload_concurrency(original_size: int, requested: int | None) -> int:
    if requested is not None and requested > 0:
        return min(16, max(1, int(requested)))

    if original_size >= 3 * 1024 * 1024 * 1024:
        return 2
    if original_size >= 1024 * 1024 * 1024:
        return 3
    return DEFAULT_CONCURRENCY


def _abort_upload_session(base_url: str, session_token: str, *, api_key: str) -> None:
    try:
        api_fetch_with_retry(
            base_url,
            "/api/public/upload/abort",
            api_key=api_key,
            method="POST",
            headers={"Content-Type": "application/json"},
            content=json.dumps({"sessionToken": session_token}).encode("utf-8"),
            retries=1,
        )
    except Exception:
        pass


def _upload_multipart_streaming(
    file_path: Path,
    context: EncryptionContext,
    *,
    api_key: str,
    base_url: str,
    expires_in_minutes: int,
    delete_on_download: bool,
    on_progress: Callable[[dict], None] | None,
    on_status: Callable[[dict], None] | None,
    concurrency: int | None,
) -> dict:
    max_part_size = context.meta["chunkSize"] + 16

    on_progress and on_progress({
        "stage": "starting",
        "percent": 0,
        "detail": f"{context.chunk_count} parts · {'gzip' if context.compression == 'gzip' else 'raw'} chunks",
    })

    init_payload = api_fetch_with_retry(
        base_url,
        "/api/public/upload/init",
        api_key=api_key,
        method="POST",
        headers={"Content-Type": "application/json"},
        content=json.dumps({
            "originalName": context.original_name,
            "mimeType": context.mime_type,
            "size": context.encrypted_size,
            "originalSize": context.original_size,
            "clientEncrypted": True,
            "clientEncryptionMeta": context.meta,
            "partSize": max_part_size,
            "expiresInMinutes": expires_in_minutes,
            "deleteOnDownload": delete_on_download,
        }).encode("utf-8"),
        on_status=on_status,
        rate_limit_retries=UNLIMITED_RATE_LIMIT_RETRIES,
    )

    session_token = init_payload["sessionToken"]
    worker_count = min(
        _resolve_upload_concurrency(context.original_size, concurrency or init_payload.get("concurrency")),
        context.chunk_count,
    )

    completed_parts = 0
    session_aborted = False

    def upload_part(chunk_index: int) -> int:
        part_number = chunk_index + 1
        on_progress and on_progress({
            "stage": "encrypting",
            "part": part_number,
            "totalParts": context.chunk_count,
            "percent": _upload_progress_percent(completed_parts, 1, context.chunk_count),
        })
        encrypted_part = encrypt_chunk_from_file(file_path, chunk_index, context)
        on_progress and on_progress({
            "stage": "uploading",
            "part": part_number,
            "totalParts": context.chunk_count,
            "partBytes": len(encrypted_part),
            "percent": _upload_progress_percent(completed_parts, 1, context.chunk_count),
        })
        api_fetch_with_retry(
            base_url,
            f"/api/public/upload/part?sessionToken={quote(session_token, safe='')}&partNumber={part_number}",
            api_key=api_key,
            method="PUT",
            headers={
                "Content-Type": "application/octet-stream",
                "X-Upload-Session": session_token,
            },
            content=encrypted_part,
            on_status=on_status,
            rate_limit_retries=UNLIMITED_RATE_LIMIT_RETRIES,
            max_rate_limit_wait_ms=15_000,
        )
        return part_number

    try:
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            futures = [executor.submit(upload_part, index) for index in range(context.chunk_count)]
            for future in as_completed(futures):
                future.result()
                completed_parts += 1
                on_progress and on_progress({
                    "stage": "uploaded",
                    "part": completed_parts,
                    "totalParts": context.chunk_count,
                    "percent": _upload_progress_percent(completed_parts, 0, context.chunk_count),
                    "detail": f"{completed_parts}/{context.chunk_count} parts done",
                })
    except Exception:
        if not session_aborted:
            session_aborted = True
            _abort_upload_session(base_url, session_token, api_key=api_key)
        raise

    on_progress and on_progress({"stage": "finalizing", "percent": 99, "detail": "completing upload session"})

    complete_payload = api_fetch_with_retry(
        base_url,
        "/api/public/upload/complete",
        api_key=api_key,
        method="POST",
        headers={"Content-Type": "application/json"},
        content=json.dumps({"sessionToken": session_token}).encode("utf-8"),
        on_status=on_status,
        rate_limit_retries=UNLIMITED_RATE_LIMIT_RETRIES,
    )

    if complete_payload.get("status") in ("processing", "pending"):
        complete_payload = _poll_upload_status(session_token, api_key=api_key, base_url=base_url, on_status=on_status)

    on_progress and on_progress({"stage": "complete", "percent": 100})
    share_url = _build_share_url(complete_payload, context.token)
    return _build_result(complete_payload, context, share_url)


def upload_file(
    file_path: str | Path,
    *,
    api_key: str,
    base_url: str = "https://bytifi.com",
    expires_in_minutes: int = 30,
    delete_on_download: bool = False,
    mime_type: str | None = None,
    concurrency: int | None = None,
    on_progress: Callable[[dict], None] | None = None,
    on_status: Callable[[dict], None] | None = None,
) -> dict:
    if not api_key:
        raise ValueError("API key is required.")

    def report_status(info: dict) -> None:
        on_status and on_status(info)
        on_progress and on_progress(info)

    absolute_path, context = resolve_upload_file(file_path, mime_type=mime_type)

    if context.original_size <= MULTIPART_THRESHOLD_BYTES:
        encrypted_buffer = _collect_encrypted_buffer(absolute_path, context, on_progress=report_status)
        return _upload_direct(
            context,
            encrypted_buffer,
            api_key=api_key,
            base_url=base_url,
            expires_in_minutes=expires_in_minutes,
            delete_on_download=delete_on_download,
            on_progress=report_status,
            on_status=report_status,
        )

    return _upload_multipart_streaming(
        absolute_path,
        context,
        api_key=api_key,
        base_url=base_url,
        expires_in_minutes=expires_in_minutes,
        delete_on_download=delete_on_download,
        on_progress=report_status,
        on_status=report_status,
        concurrency=concurrency,
    )
