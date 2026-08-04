from __future__ import annotations

import argparse
import json
import os
import sys

from . import __version__
from .api import BytifiApiError, BytifiNetworkError
from .decrypt import decrypt_from_link
from .upload import upload_file
from .url import validate_base_url

VALID_EXPIRES = {5, 15, 30, 60, 120}


def _validate_expires(value: int) -> int:
    if value not in VALID_EXPIRES:
        raise argparse.ArgumentTypeError(f"expires must be one of {sorted(VALID_EXPIRES)}")
    return value


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
    parser.add_argument("--concurrency", type=int, default=None)
    parser.add_argument("--base-url", default="https://bytifi.com")


def _build_decrypt_parser(subparsers: argparse._SubParsersAction) -> None:
    parser = subparsers.add_parser("decrypt", help="Decrypt from a share link")
    parser.add_argument("input")
    parser.add_argument("--token", default="")
    parser.add_argument("--upload-json", default="")
    parser.add_argument("-o", "--output", default="")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--concurrency", type=int, default=2)
    parser.add_argument("-q", "--quiet", action="store_true")
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--base-url", default="https://bytifi.com")


def _run_upload(args: argparse.Namespace) -> int:
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
            print(f"\r{stage} {part}/{total} {percent or 0}% {detail}".strip(), end="", flush=True)
        elif percent is not None:
            print(f"\r{stage} {percent}% {detail}".strip(), end="", flush=True)

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

    if not args.quiet:
        print()

    if args.json:
        print(json.dumps(result, indent=2))
    elif args.quiet:
        print(result["shareUrl"])
    else:
        print(result["shareUrl"])

    return 0


def _run_decrypt(args: argparse.Namespace) -> int:
    base_url = validate_base_url(args.base_url)

    try:
        output_path = decrypt_from_link(
            args.input,
            encryption_token=args.token,
            base_url=base_url,
            output_path=args.output or None,
            upload_json_path=args.upload_json or None,
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

    print(str(output_path) if args.quiet else f"Decrypted to {output_path}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="bytifi", description=f"Bytifi CLI v{__version__}")
    parser.add_argument("-V", "--version", action="version", version=f"bytifi {__version__}")
    subparsers = parser.add_subparsers(dest="command", required=True)
    _build_upload_parser(subparsers)
    _build_decrypt_parser(subparsers)

    args = parser.parse_args(argv)

    if args.command == "upload":
        return _run_upload(args)
    if args.command == "decrypt":
        return _run_decrypt(args)

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
