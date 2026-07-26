from __future__ import annotations

import email.utils
import json
import time
from typing import Any, Callable

import httpx

from .url import normalize_base_url

MAX_RETRIES = 3
UNLIMITED_RATE_LIMIT_RETRIES = 10_000


class BytifiApiError(Exception):
    def __init__(self, message: str, *, status: int = 0, body: Any = None, retry_after_ms: int | None = None):
        super().__init__(message)
        self.status = status
        self.body = body
        self.retry_after_ms = retry_after_ms


class BytifiNetworkError(Exception):
    def __init__(self, message: str, *, cause: Exception | None = None):
        super().__init__(message)
        self.cause = cause


def sleep_ms(ms: int) -> None:
    time.sleep(ms / 1000)


def parse_retry_after_ms(response: httpx.Response) -> int | None:
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            seconds = float(retry_after)
            if seconds >= 0:
                return int(seconds * 1000)
        except ValueError:
            parsed = email.utils.parsedate_to_datetime(retry_after)
            if parsed is not None:
                return max(0, int(parsed.timestamp() * 1000 - time.time() * 1000))

    reset_header = response.headers.get("RateLimit-Reset")
    if reset_header:
        try:
            reset_value = float(reset_header)
            if reset_value > 1_000_000_000:
                return max(0, int(reset_value * 1000 - time.time() * 1000))
            return max(0, int(reset_value * 1000))
        except ValueError:
            pass

    return None


def is_retryable_error(error: Exception) -> bool:
    if isinstance(error, BytifiNetworkError):
        return True
    if isinstance(error, BytifiApiError):
        return error.status == 429 or error.status >= 500
    return False


def api_fetch(
    base_url: str,
    path: str,
    *,
    api_key: str | None = None,
    method: str = "GET",
    headers: dict | None = None,
    content: bytes | None = None,
    data: dict | None = None,
    files: dict | None = None,
    binary: bool = False,
    timeout: float = 300.0,
) -> Any:
    url = f"{normalize_base_url(base_url)}{path}"
    request_headers = dict(headers or {})
    if api_key:
        request_headers["Authorization"] = f"Bearer {api_key}"

    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.request(
                method,
                url,
                headers=request_headers,
                content=content,
                data=data,
                files=files,
            )
    except httpx.HTTPError as error:
        raise BytifiNetworkError(str(error) or "Network request failed.", cause=error) from error

    raw = response.content

    if not response.is_success:
        text = raw.decode("utf-8", errors="replace")
        payload: Any = text
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            pass

        if isinstance(payload, dict) and payload.get("error"):
            message = payload["error"]
        elif isinstance(payload, str) and payload:
            message = payload
        else:
            message = f"Request failed with status {response.status_code}."

        raise BytifiApiError(
            message,
            status=response.status_code,
            body=payload,
            retry_after_ms=parse_retry_after_ms(response) if response.status_code == 429 else None,
        )

    if binary:
        return raw

    text = raw.decode("utf-8")
    if not text:
        return None

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


def api_fetch_with_retry(
    base_url: str,
    path: str,
    *,
    retries: int = MAX_RETRIES,
    rate_limit_retries: int = 0,
    max_rate_limit_wait_ms: int | None = None,
    on_status: Callable[[dict], None] | None = None,
    **fetch_options: Any,
) -> Any:
    attempt = 0
    rate_limit_attempt = 0
    max_rate_limit = UNLIMITED_RATE_LIMIT_RETRIES if rate_limit_retries == UNLIMITED_RATE_LIMIT_RETRIES else (rate_limit_retries or retries)

    while True:
        try:
            return api_fetch(base_url, path, **fetch_options)
        except BytifiApiError as error:
            if error.status == 429:
                if rate_limit_attempt >= max_rate_limit:
                    raise
                rate_limit_attempt += 1
                server_wait_ms = error.retry_after_ms if error.retry_after_ms is not None else min(600_000, 15_000 * rate_limit_attempt)
                wait_ms = server_wait_ms if max_rate_limit_wait_ms is None else min(server_wait_ms, max_rate_limit_wait_ms)
                on_status and on_status({
                    "stage": "waiting",
                    "message": f"Rate limited — waiting {wait_ms // 1000}s before retry ({rate_limit_attempt})…",
                    "waitMs": wait_ms,
                    "retryAttempt": rate_limit_attempt,
                })
                sleep_ms(wait_ms)
                continue

            if not is_retryable_error(error) or attempt >= retries:
                raise

            attempt += 1
            sleep_ms(min(1000 * (2 ** attempt), 8000))
        except BytifiNetworkError:
            if attempt >= retries:
                raise
            attempt += 1
            sleep_ms(min(1000 * (2 ** attempt), 8000))


def public_fetch_with_retry(base_url: str, path: str, **options: Any) -> Any:
    return api_fetch_with_retry(
        base_url,
        path,
        rate_limit_retries=UNLIMITED_RATE_LIMIT_RETRIES,
        api_key=None,
        **options,
    )


def fetch_public_binary_with_retry(base_url: str, path: str, **options: Any) -> bytes:
    return api_fetch_with_retry(
        base_url,
        path,
        rate_limit_retries=UNLIMITED_RATE_LIMIT_RETRIES,
        api_key=None,
        binary=True,
        **options,
    )
