from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys

from . import __version__
from .api import BytifiApiError, BytifiNetworkError, request_cancel, use_http_client
from .decrypt import decrypt_from_link
from .upload import upload_file
from .url import validate_base_url

VALID_EXPIRES = {5, 15, 30, 60, 120}
_progress_width = 0


def _validate_expires(value: str) -> int:
    if not re.fullmatch(r"[0-9]+", value):
        raise argparse.ArgumentTypeError("expires must be a plain integer: 5, 15, 30, 60, or 120.")
    number = int(value)
    if number not in VALID_EXPIRES:
        raise argparse.ArgumentTypeError(f"expires must be one of {sorted(VALID_EXPIRES)}")
    return number


def _validate_concurrency(maximum: int):
    def parse(value: str) -> int:
        if not re.fullmatch(r"[0-9]+", value):
            raise argparse.ArgumentTypeError(f"concurrency must be a plain integer between 1 and {maximum}.")
        number = int(value)
        if number < 1 or number > maximum:
            raise argparse.ArgumentTypeError(f"concurrency must be an integer between 1 and {maximum}.")
        return number

    return parse


def _build_upload_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("upload", help="Encrypt and upload a file")
    parser.add_argument("file")
    parser.add_argument("-k", "--api-key", default=os.environ.get("BYTIFI_API_KEY", ""))
    parser.add_argument("-e", "--expires", type=_validate_expires, default=30)
    parser.add_argument("--delete-on-download", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("-q", "--quiet", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--mime-type", default="")
    parser.add_argument("--concurrency", type=_validate_concurrency(16), default=None)
    parser.add_argument("--base-url", default="https://bytifi.com")


def _build_decrypt_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("decrypt", help="Decrypt from a share link")
    parser.add_argument("input")
    parser.add_argument("--token", default="")
    parser.add_argument("--link", default="")
    parser.add_argument("--meta", default="")
    parser.add_argument("--upload-json", default="")
    parser.add_argument("--share-url", default="")
    parser.add_argument("--local-file", action="store_true")
    parser.add_argument("-o", "--output", default="")
    parser.add_argument("--output-dir", default="")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--concurrency", type=_validate_concurrency(8), default=2)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("-q", "--quiet", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--base-url", default="https://bytifi.com")


def _write_progress(line: str) -> None:
    global _progress_width
    visible = line
    if len(line) < _progress_width:
        visible = line + (" " * (_progress_width - len(line)))
    _progress_width = len(line)
    print(f"\r{visible}", end="", file=sys.stderr, flush=True)


def _finish_progress() -> None:
    global _progress_width
    _progress_width = 0
    print(file=sys.stderr)


def _reject_json_and_quiet(args: argparse.Namespace) -> int | None:
    if args.json and args.quiet:
        print("Use either --json or --quiet, not both.", file=sys.stderr)
        return 1
    return None


def _run_upload(args: argparse.Namespace) -> int:
    rejected = _reject_json_and_quiet(args)
    if rejected is not None:
        return rejected
    if not args.api_key:
        print("Missing API key. Pass --api-key or set BYTIFI_API_KEY.", file=sys.stderr)
        return 1

    base_url = validate_base_url(args.base_url)

    def on_progress(info: dict) -> None:
        if args.quiet or args.json:
            return
        stage = info.get("stage", "")
        percent = info.get("percent")
        detail = info.get("detail") or ""
        part = info.get("part")
        total = info.get("totalParts")
        if part and total:
            _write_progress(f"{stage} {part}/{total} {percent or 0}% {detail}".strip())
        elif percent is not None:
            _write_progress(f"{stage} {percent}% {detail}".strip())

    try:
        result = upload_file(
            args.file,
            api_key=args.api_key,
            base_url=base_url,
            expires_in_minutes=args.expires,
            delete_on_download=args.delete_on_download,
            mime_type=args.mime_type or None,
            concurrency=args.concurrency,
            on_progress=on_progress,
        )
    except BytifiApiError as error:
        print(str(error), file=sys.stderr)
        if args.verbose and error.body is not None:
            print(error.body, file=sys.stderr)
        return 2
    except BytifiNetworkError as error:
        print(str(error), file=sys.stderr)
        return 3
    except (ValueError, FileNotFoundError, TimeoutError) as error:
        print(str(error), file=sys.stderr)
        return 1

    if not args.quiet and not args.json:
        _finish_progress()

    if args.json:
        print(json.dumps(result, indent=2))
    elif args.quiet:
        print(result["shareUrl"])
    else:
        print(f"Share URL:\n{result['shareUrl']}")
        print(f"Encrypted file:\n{result.get('encryptedFile') or result.get('url') or ''}")
        print(f"Expires: {result.get('expiresAt')}")

    return 0


def _run_decrypt(args: argparse.Namespace) -> int:
    rejected = _reject_json_and_quiet(args)
    if rejected is not None:
        return rejected
    base_url = validate_base_url(args.base_url)

    try:
        output_path = decrypt_from_link(
            args.input,
            encryption_token=args.token,
            base_url=base_url,
            output_path=args.output or None,
            output_dir=args.output_dir or None,
            upload_json_path=args.upload_json or None,
            meta_path=args.meta or None,
            link_token=args.link,
            share_url=args.share_url,
            local_file=args.local_file,
            force=args.force,
            concurrency=args.concurrency,
        )
    except BytifiApiError as error:
        print(str(error), file=sys.stderr)
        if args.verbose and error.body is not None:
            print(error.body, file=sys.stderr)
        return 2
    except BytifiNetworkError as error:
        print(str(error), file=sys.stderr)
        return 3
    except (ValueError, FileExistsError, FileNotFoundError, TimeoutError) as error:
        print(str(error), file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps({"outputPath": str(output_path)}, indent=2))
    else:
        print(str(output_path) if args.quiet else f"Decrypted to {output_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bytifi", description=f"Bytifi CLI v{__version__}")
    parser.add_argument("-V", "--version", action="version", version=f"bytifi {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    _build_upload_parser(subparsers)
    _build_decrypt_parser(subparsers)

    args = parser.parse_args(argv)
    signal.signal(signal.SIGINT, lambda *_args: request_cancel())

    try:
        with use_http_client():
            if args.command == "upload":
                return _run_upload(args)
            if args.command == "decrypt":
                return _run_decrypt(args)
    except KeyboardInterrupt:
        print("Aborted.", file=sys.stderr)
        return 130

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
