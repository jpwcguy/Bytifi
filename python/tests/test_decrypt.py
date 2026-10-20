import json
import tempfile
import unittest
from pathlib import Path

from bytifi.cli import main
from bytifi.crypto import create_encryption_context, encrypt_chunk_from_file
from bytifi.decrypt import (
    decrypt_from_link,
    load_upload_json,
    parse_decrypt_input,
    sanitize_output_name,
    to_extended_length_path,
)
from bytifi.upload import _build_result


class DecryptPathTests(unittest.TestCase):
    def test_reserved_names_and_trailing_dots(self) -> None:
        self.assertEqual(sanitize_output_name("CON"), "CON_")
        self.assertEqual(sanitize_output_name("nul.txt"), "nul_.txt")
        self.assertEqual(sanitize_output_name("report.txt. "), "report.txt")

    def test_long_windows_path(self) -> None:
        long_path = "C:\\files\\" + ("a" * 250) + ".bin"
        self.assertTrue(str(to_extended_length_path(long_path, platform="nt")).startswith("\\\\?\\"))
        self.assertEqual(str(to_extended_length_path("C:\\short.bin", platform="nt")), "C:\\short.bin")

    def test_token_fragment_is_decoded(self) -> None:
        parsed = parse_decrypt_input("https://bytifi.com/link?link=abc#token=abc%2Fdef")
        self.assertEqual(parsed["encryptionToken"], "abc/def")
        self.assertEqual(parsed["linkToken"], "abc")

    def test_upload_json_bom_and_validation(self) -> None:
        context = create_encryption_context(original_size=4, original_name="a.txt", mime_type="text/plain")
        with tempfile.TemporaryDirectory() as directory:
            json_path = Path(directory) / "upload.json"
            json_path.write_text("\ufeff" + json.dumps({
                "encryptionToken": context.token,
                "clientEncryptionMeta": context.meta,
                "link": "abc",
                "baseUrl": "https://files.example",
            }), encoding="utf-8")
            loaded = load_upload_json(json_path)
            self.assertEqual(loaded["encryptionToken"], context.token)
            self.assertEqual(loaded["baseUrl"], "https://files.example")

            empty = Path(directory) / "empty.json"
            empty.write_text("{}", encoding="utf-8")
            with self.assertRaises(ValueError):
                load_upload_json(empty)

    def test_result_includes_base_url(self) -> None:
        context = create_encryption_context(original_size=1, original_name="a.txt")
        result = _build_result(
            {"url": "https://bytifi.com/link?link=abc", "token": "abc"},
            context,
            "https://bytifi.com/link?link=abc#token=key",
            "https://files.example",
        )
        self.assertEqual(result["baseUrl"], "https://files.example")

    def test_local_decrypt_and_failed_overwrite(self) -> None:
        plain = b"hello bytifi local decrypt"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "plain.txt"
            source.write_bytes(plain)
            context = create_encryption_context(
                original_size=len(plain),
                original_name="plain.txt",
                mime_type="text/plain",
            )
            encrypted = encrypt_chunk_from_file(source, 0, context)
            encrypted_path = root / "file.encrypted"
            encrypted_path.write_bytes(encrypted)
            upload_json = root / "upload.json"
            upload_json.write_text(json.dumps({
                "link": "abc",
                "encryptionToken": context.token,
                "clientEncryptionMeta": context.meta,
                "originalName": "plain.txt",
                "baseUrl": "https://example.test",
            }), encoding="utf-8")
            output = root / "restored.txt"
            restored = decrypt_from_link(
                str(encrypted_path),
                upload_json_path=upload_json,
                output_path=output,
                local_file=True,
            )
            self.assertEqual(restored.read_bytes(), plain)

            output.write_text("keep-me", encoding="utf-8")
            other = create_encryption_context(original_size=len(plain), original_name="plain.txt")
            bad_json = root / "bad.json"
            bad_json.write_text(json.dumps({
                "link": "abc",
                "encryptionToken": other.token,
                "clientEncryptionMeta": context.meta,
                "originalName": "plain.txt",
            }), encoding="utf-8")
            with self.assertRaises(Exception):
                decrypt_from_link(
                    str(encrypted_path),
                    upload_json_path=bad_json,
                    output_path=output,
                    local_file=True,
                    force=True,
                )
            self.assertEqual(output.read_text(encoding="utf-8"), "keep-me")

    def test_local_parts_round_trip(self) -> None:
        plain = b"abcdefghijkl"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "plain.bin"
            source.write_bytes(plain)
            context = create_encryption_context(
                original_size=len(plain),
                original_name="plain.bin",
                mime_type="application/octet-stream",
                plain_chunk_size=8,
            )
            parts = root / "parts"
            parts.mkdir()
            for index in range(context.chunk_count):
                (parts / f"{index + 1}.part").write_bytes(encrypt_chunk_from_file(source, index, context))
            upload_json = root / "upload.json"
            upload_json.write_text(json.dumps({
                "link": "parts",
                "encryptionToken": context.token,
                "clientEncryptionMeta": context.meta,
                "originalName": "plain.bin",
            }), encoding="utf-8")
            output = root / "restored.bin"
            decrypt_from_link(str(parts), upload_json_path=upload_json, output_path=output, local_file=True)
            self.assertEqual(output.read_bytes(), plain)

    def test_flags_match_node_cli(self) -> None:
        self.assertEqual(main(["decrypt", "--json", "--quiet", "file.bin"]), 1)
        with self.assertRaises(SystemExit) as concurrency:
            main(["decrypt", "file.bin", "--concurrency", "9"])
        self.assertEqual(concurrency.exception.code, 2)
        with self.assertRaises(SystemExit) as expires:
            main(["upload", "file.bin", "--expires", "1.5e1"])
        self.assertEqual(expires.exception.code, 2)
        with self.assertRaises(SystemExit) as upload_concurrency:
            main(["upload", "file.bin", "--concurrency", "0"])
        self.assertEqual(upload_concurrency.exception.code, 2)
