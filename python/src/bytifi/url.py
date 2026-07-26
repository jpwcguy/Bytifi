DEFAULT_BASE_URL = "https://bytifi.com"


def normalize_base_url(base_url: str | None) -> str:
    return str(base_url or DEFAULT_BASE_URL).rstrip("/")


def validate_base_url(url: str) -> str:
    from urllib.parse import urlparse

    normalized = normalize_base_url(url)
    parsed = urlparse(normalized)

    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Invalid base URL protocol: {parsed.scheme} (use http: or https:)")
    if not parsed.hostname:
        raise ValueError("Invalid base URL: missing hostname.")

    return normalized
