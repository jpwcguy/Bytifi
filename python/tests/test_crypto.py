import unittest

from bytifi.base64url import from_base64url, to_base64url
from bytifi.crypto import (
    compress_plain_chunk,
    create_encryption_context,
    decrypt_plain_chunk_from_encrypted,
    encrypt_chunk,
    import_token,
)


class CryptoTests(unittest.TestCase):
    def test_encrypt_decrypt_round_trip(self) -> None:
        plain = b"hello bytifi round trip test data"
        context = create_encryption_context(
            original_size=len(plain),
            original_name="test.txt",
            mime_type="text/plain",
        )

        payload = plain
        if context.compression == "gzip":
            payload = compress_plain_chunk(plain)

        encrypted = encrypt_chunk(payload, context.token_bytes, context.nonce_prefix, 0)
        decrypted = decrypt_plain_chunk_from_encrypted(
            encrypted,
            import_token(context.token),
            context.nonce_prefix,
            0,
            context.meta,
        )
        self.assertEqual(decrypted, plain)

    def test_base64url_round_trip(self) -> None:
        original = b"round-trip-base64url"
        self.assertEqual(from_base64url(to_base64url(original)), original)

    def test_token_import_matches_context(self) -> None:
        context = create_encryption_context(original_size=16, original_name="x.bin")
        self.assertEqual(import_token(context.token), context.token_bytes)


if __name__ == "__main__":
    unittest.main()
