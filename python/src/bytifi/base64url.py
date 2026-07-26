import base64
import re

_BASE64URL_CHARSET = re.compile(r"^[A-Za-z0-9_-]*$")


def to_base64url(data: bytes) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return encoded.replace("+", "-").replace("/", "_").rstrip("=")


def from_base64url(value: str) -> bytes:
    normalized = str(value or "")
    if not _BASE64URL_CHARSET.fullmatch(normalized):
        raise ValueError("Invalid base64url string: contains disallowed characters.")

    padded = normalized.replace("-", "+").replace("_", "/")
    padded += "=" * ((4 - len(padded) % 4) % 4)
    return base64.b64decode(padded)
