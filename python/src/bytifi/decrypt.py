from __future__ import annotations

import json
import os
import re
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, quote, unquote_plus, urlparse

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

WINDOWS_RESERVED_NAME = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)", re.I)


def _strip_bom(text: str) -> str:
    return text[1:] if text.startswith("\ufeff") else text


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
                resolved_encryption_token = unquote_plus(part.split("=", 1)[1])

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


def parse_share_reference(input_value: str, *, encryption_token: str = "", base_url: str | None = None) -> dict:
    trimmed = str(input_value or "").strip()
    token = str(encryption_token or "").strip()
    if not trimmed:
        return {"baseUrl": normalize_base_url(base_url), "linkToken": "", "encryptionToken": token}
    if not re.match(r"^https?://", trimmed, re.I) and not trimmed.startswith("/"):
        return {"baseUrl": normalize_base_url(base_url), "linkToken": trimmed, "encryptionToken": token}

    resolved_base = normalize_base_url(base_url)
    url = urlparse(trimmed if re.match(r"^https?://", trimmed, re.I) else f"{resolved_base}{trimmed}")
    if url.scheme and url.netloc:
        resolved_base = f"{url.scheme}://{url.netloc}"
    fragment = url.fragment[1:] if url.fragment.startswith("#") else url.fragment
    for part in fragment.split("&"):
        if part.startswith("token=") and not token:
            token = unquote_plus(part.split("=", 1)[1])
    query = parse_qs(url.query)
    link_token = (query.get("link") or [""])[0]
    if not link_token:
        match = re.match(r"^/f/([^/]+)", url.path)
        link_token = match.group(1) if match else ""
    return {"baseUrl": resolved_base, "linkToken": link_token, "encryptionToken": token}


def load_upload_json(upload_json_path: str | Path) -> dict:
    raw = _strip_bom(Path(upload_json_path).read_text(encoding="utf-8-sig"))
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError("Invalid upload JSON file.") from error

    meta = normalize_client_encryption_meta(parsed.get("clientEncryptionMeta"))
    if not meta:
        raise ValueError("Upload JSON is missing clientEncryptionMeta.")

    encryption_token = str(parsed.get("encryptionToken") or "").strip()
    if not encryption_token:
        raise ValueError("Upload JSON is missing encryptionToken.")

    return {
        "linkToken": str(parsed.get("link") or parsed.get("token") or "").strip(),
        "encryptionToken": encryption_token,
        "clientEncryptionMeta": meta,
        "baseUrl": normalize_base_url(parsed.get("baseUrl") or "https://bytifi.com"),
        "originalName": parsed.get("originalName") or "download",
        "shareUrl": parsed.get("shareUrl") or "",
        "expiresAt": parsed.get("expiresAt"),
    }


def sanitize_output_name(filename: str) -> str:
    base = Path(str(filename or "download").replace("\0", "").replace("\r", "").replace("\n", "")).name
    base = re.sub(r"[. ]+$", "", base)
    if base in ("", ".", ".."):
        return "download"

    stem = base.split(".", 1)[0]
    if WINDOWS_RESERVED_NAME.match(stem) or WINDOWS_RESERVED_NAME.match(base):
        dot = base.find(".")
        base = f"{base}_" if dot == -1 else f"{base[:dot]}_{base[dot:]}"
    return base or "download"


def to_extended_length_path(resolved_path: str | Path, platform: str | None = None) -> Path:
    system = platform or os.name
    if system != "nt":
        return Path(resolved_path).resolve()

    normalized = str(resolved_path).replace("/", "\\")
    if normalized.startswith("\\\\?\\"):
        return Path(normalized)
    if normalized.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + normalized[2:])
    if len(normalized) >= 260:
        return Path("\\\\?\\" + normalized)
    return Path(normalized)


def _looks_like_remote(value: str) -> bool:
    trimmed = value.strip()
    return bool(re.match(r"^https?://", trimmed, re.I) or trimmed.startswith("/link") or trimmed.startswith("/f/"))


def _fetch_link_info(base_url: str, link_token: str, on_status: Callable | None = None) -> dict:
    return public_fetch_with_retry(
        base_url,
        f"/api/link/{quote(link_token, safe='')}",
        on_status=on_status,
    )


def _read_meta_file(meta_path: str | Path) -> dict:
    raw = _strip_bom(Path(meta_path).read_text(encoding="utf-8-sig"))
    parsed = json.loads(raw)
    meta = normalize_client_encryption_meta(parsed.get("clientEncryptionMeta") or parsed)
    if not meta:
        raise ValueError("Invalid encryption metadata file.")
    return meta


def _resolve_output_path(output: str | Path | None, output_dir: str | Path | None, fallback_name: str) -> Path:
    if output:
        requested = Path(output)
    else:
        requested = Path(output_dir or Path.cwd()) / sanitize_output_name(fallback_name)
    safe = requested.parent / sanitize_output_name(requested.name)
    return to_extended_length_path(safe)


def _partial_path(output_path: Path) -> Path:
    return output_path.with_name(f"{output_path.name}.{os.getpid()}.bytifi-partial")


def _commit_output(temp_path: Path, output_path: Path) -> None:
    if os.name != "nt":
        temp_path.replace(output_path)
        return

    backup = None
    if output_path.exists():
        backup = output_path.with_name(f"{output_path.name}.{os.getpid()}.bytifi-backup")
        output_path.replace(backup)
    try:
        temp_path.replace(output_path)
    except Exception:
        if backup is not None and backup.exists() and not output_path.exists():
            backup.replace(output_path)
        raise
    if backup is not None:
        backup.unlink(missing_ok=True)


def _require_concurrency(concurrency: int) -> int:
    if isinstance(concurrency, bool) or not isinstance(concurrency, int) or concurrency < 1 or concurrency > 8:
        raise ValueError("concurrency must be an integer between 1 and 8.")
    return concurrency


def _import_nonce(meta: dict, encryption_token: str) -> tuple[bytes, bytes]:
    token_bytes = import_token(encryption_token)
    nonce_prefix = from_base64url(meta["noncePrefix"])
    if len(nonce_prefix) != 8:
        raise ValueError("Invalid encryption metadata: noncePrefix must be 8 bytes.")
    return token_bytes, nonce_prefix


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
    worker_count = min(_require_concurrency(concurrency), len(chunks))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.touch()
    write_lock = threading.Lock()

    def process_part(index: int) -> None:
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
        with write_lock:
            with output_path.open("r+b") as handle:
                handle.seek(chunk["chunkIndex"] * meta["chunkSize"])
                handle.write(plain_part)

    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(process_part, index) for index in range(len(chunks))]
        try:
            for future in as_completed(futures):
                future.result()
        except Exception:
            for pending in futures:
                pending.cancel()
            executor.shutdown(wait=False, cancel_futures=True)
            raise

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
    parsed = urlparse(
        encrypted_file_url
        if re.match(r"^https?://", encrypted_file_url, re.I)
        else f"{normalize_base_url(base_url)}{encrypted_file_url}"
    )
    download_base = f"{parsed.scheme}://{parsed.netloc}"
    download_path = parsed.path + (f"?{parsed.query}" if parsed.query else "")
    encrypted_buffer = fetch_public_binary_with_retry(download_base, download_path, on_status=on_status)
    _write_decrypted_buffer(encrypted_buffer, meta, token_bytes, nonce_prefix, output_path, on_progress)


def _write_decrypted_buffer(encrypted_buffer: bytes, meta: dict, token_bytes: bytes, nonce_prefix: bytes, output_path: Path, on_progress: Callable | None) -> None:
    plan = build_encrypted_chunk_plan(meta)
    if uses_chunk_compression(meta) and len(plan["chunks"]) != 1:
        raise ValueError("Compressed files with multiple chunks require part-based download.")

    with output_path.open("wb") as handle:
        offset = 0
        for chunk in plan["chunks"]:
            if uses_chunk_compression(meta):
                encrypted_chunk = encrypted_buffer
            else:
                encrypted_size = chunk["encryptedSize"]
                encrypted_chunk = encrypted_buffer[offset:offset + encrypted_size]
                if len(encrypted_chunk) != encrypted_size:
                    raise ValueError("Encrypted file ended before all parts were downloaded.")
                offset += encrypted_size
            plain_part = decrypt_plain_chunk_from_encrypted(
                encrypted_chunk,
                token_bytes,
                nonce_prefix,
                chunk["chunkIndex"],
                meta,
            )
            handle.write(plain_part)
    on_progress and on_progress({"stage": "complete", "percent": 100})


def _list_local_parts(directory: Path) -> list[tuple[int, Path]]:
    parts = []
    for entry in directory.iterdir():
        match = re.match(r"^(\d+)(?:\.part)?$", entry.name)
        if match and entry.is_file():
            parts.append((int(match.group(1)), entry))
    parts.sort(key=lambda item: item[0])
    if not parts:
        raise ValueError("No numbered part files found in directory. Expected names like 1, 2, or 1.part, 2.part.")
    return parts


def _decrypt_local_parts(directory: Path, meta: dict, token_bytes: bytes, nonce_prefix: bytes, output_path: Path, on_progress: Callable | None) -> None:
    plan = build_encrypted_chunk_plan(meta)
    parts = _list_local_parts(directory)
    if len(parts) != len(plan["chunks"]):
        raise ValueError(f"Expected {len(plan['chunks'])} part files, found {len(parts)}.")

    with output_path.open("wb") as handle:
        for chunk in plan["chunks"]:
            part_number = chunk["chunkIndex"] + 1
            found = parts[chunk["chunkIndex"]]
            if found[0] != part_number:
                raise ValueError(f"Missing local part file {part_number}.")
            encrypted_part = found[1].read_bytes()
            plain_part = decrypt_plain_chunk_from_encrypted(
                encrypted_part,
                token_bytes,
                nonce_prefix,
                chunk["chunkIndex"],
                meta,
            )
            handle.write(plain_part)
    on_progress and on_progress({"stage": "complete", "percent": 100})


def _decrypt_local_file(encrypted_path: Path, meta: dict, token_bytes: bytes, nonce_prefix: bytes, output_path: Path, on_progress: Callable | None) -> None:
    plan = build_encrypted_chunk_plan(meta)
    if uses_chunk_compression(meta) and meta["chunkCount"] != 1:
        raise ValueError("Compressed multi-chunk files must be decrypted from a parts directory.")

    if encrypted_path.stat().st_size <= 64 * 1024 * 1024:
        _write_decrypted_buffer(encrypted_path.read_bytes(), meta, token_bytes, nonce_prefix, output_path, on_progress)
        return

    offset = 0
    with encrypted_path.open("rb") as source, output_path.open("wb") as handle:
        for chunk in plan["chunks"]:
            source.seek(offset)
            encrypted_chunk = source.read(chunk["encryptedSize"])
            if len(encrypted_chunk) != chunk["encryptedSize"]:
                raise ValueError("Encrypted file ended before all parts were read.")
            plain_part = decrypt_plain_chunk_from_encrypted(
                encrypted_chunk,
                token_bytes,
                nonce_prefix,
                chunk["chunkIndex"],
                meta,
            )
            handle.write(plain_part)
            offset += chunk["encryptedSize"]
    on_progress and on_progress({"stage": "complete", "percent": 100})


def _prepare_output(output_path: Path, force: bool) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.is_dir():
        raise IsADirectoryError(f"Output path is a directory: {output_path}")
    if output_path.exists() and not force:
        raise FileExistsError(f"Output file already exists: {output_path}")


def _run_to_temp(output_path: Path, force: bool, writer: Callable[[Path], None]) -> None:
    _prepare_output(output_path, force)
    temp_path = _partial_path(output_path)
    try:
        writer(temp_path)
        _commit_output(temp_path, output_path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def decrypt_from_link(
    input_value: str,
    *,
    encryption_token: str = "",
    base_url: str | None = None,
    output_path: str | Path | None = None,
    output_dir: str | Path | None = None,
    upload_json_path: str | Path | None = None,
    meta_path: str | Path | None = None,
    link_token: str = "",
    share_url: str = "",
    local_file: bool = False,
    force: bool = False,
    concurrency: int = 2,
    on_progress: Callable | None = None,
    on_status: Callable | None = None,
) -> Path:
    concurrency = _require_concurrency(concurrency)
    upload_json = load_upload_json(upload_json_path) if upload_json_path else None
    inline_meta = upload_json["clientEncryptionMeta"] if upload_json else None
    if meta_path:
        inline_meta = _read_meta_file(meta_path)

    share = parse_share_reference(
        share_url,
        encryption_token=encryption_token or (upload_json["encryptionToken"] if upload_json else ""),
        base_url=(upload_json["baseUrl"] if upload_json else base_url),
    )
    resolved_token = encryption_token or share["encryptionToken"] or (upload_json["encryptionToken"] if upload_json else "")
    resolved_link = link_token or (upload_json["linkToken"] if upload_json else "") or share["linkToken"]
    resolved_base = (upload_json["baseUrl"] if upload_json and upload_json.get("baseUrl") else None) or share["baseUrl"] or normalize_base_url(base_url)
    original_name = (upload_json or {}).get("originalName") or "download"

    trimmed = str(input_value or "").strip()
    local_candidate = Path(trimmed) if trimmed else None
    treat_as_local = bool(local_file or (trimmed and not _looks_like_remote(trimmed) and local_candidate is not None and local_candidate.exists()))

    if treat_as_local:
        assert local_candidate is not None
        source = local_candidate.resolve()
        if inline_meta is None and resolved_link:
            link_info = _fetch_link_info(resolved_base, resolved_link, on_status=on_status)
            if link_info.get("status") == "expired":
                raise ValueError("This file link has expired.")
            inline_meta = normalize_client_encryption_meta(link_info.get("clientEncryptionMeta"))
            original_name = link_info.get("originalName") or original_name
        if not inline_meta:
            raise ValueError("Upload JSON is missing clientEncryptionMeta.")
        if not resolved_token:
            raise ValueError("Missing encryption token. Pass --token or --upload-json.")

        token_bytes, nonce_prefix = _import_nonce(inline_meta, resolved_token)
        final_output = _resolve_output_path(output_path, output_dir, original_name)

        def write_local(temp_path: Path) -> None:
            if source.is_dir():
                _decrypt_local_parts(source, inline_meta, token_bytes, nonce_prefix, temp_path, on_progress)
            else:
                _decrypt_local_file(source, inline_meta, token_bytes, nonce_prefix, temp_path, on_progress)

        _run_to_temp(final_output, force, write_local)
        return final_output

    parsed_input = None
    if trimmed:
        parsed_input = parse_decrypt_input(trimmed, encryption_token=resolved_token, base_url=resolved_base)
    parsed = {
        "baseUrl": resolved_base or (parsed_input or {}).get("baseUrl"),
        "linkToken": resolved_link or (parsed_input or {}).get("linkToken") or "",
        "encryptionToken": resolved_token or (parsed_input or {}).get("encryptionToken") or "",
    }

    complete_upload = bool(inline_meta and parsed["encryptionToken"] and parsed["linkToken"])
    link_info = None if complete_upload else _fetch_link_info(parsed["baseUrl"], parsed["linkToken"], on_status=on_status)
    if link_info is not None:
        if link_info.get("status") == "expired":
            raise ValueError("This file link has expired.")
        if not link_info.get("clientEncrypted"):
            raise ValueError("This link is not an encrypted file.")
        original_name = link_info.get("originalName") or original_name

    meta = inline_meta or normalize_client_encryption_meta((link_info or {}).get("clientEncryptionMeta"))
    if not meta:
        raise ValueError("Invalid encryption metadata for this file.")

    token_bytes, nonce_prefix = _import_nonce(meta, parsed["encryptionToken"])
    final_output = _resolve_output_path(output_path, output_dir, original_name)
    storage_mode = (link_info or {}).get("storageMode") or ("parts" if meta["chunkCount"] > 1 else "single")
    part_count = int((link_info or {}).get("partCount") or meta["chunkCount"] or 0)

    def write_remote(temp_path: Path) -> None:
        if storage_mode == "parts" or part_count > 1:
            _decrypt_from_parts(
                base_url=parsed["baseUrl"],
                link_token=parsed["linkToken"],
                meta=meta,
                token_bytes=token_bytes,
                nonce_prefix=nonce_prefix,
                output_path=temp_path,
                on_progress=on_progress,
                on_status=on_status,
                concurrency=concurrency,
            )
            return
        encrypted_file_url = (link_info or {}).get("encryptedFile") or (link_info or {}).get("downloadUrl") or f"/f/{parsed['linkToken']}/encrypted"
        _decrypt_from_single_file(
            encrypted_file_url=encrypted_file_url,
            meta=meta,
            token_bytes=token_bytes,
            nonce_prefix=nonce_prefix,
            output_path=temp_path,
            base_url=parsed["baseUrl"],
            on_progress=on_progress,
            on_status=on_status,
        )

    _run_to_temp(final_output, force, write_remote)
    return final_output
