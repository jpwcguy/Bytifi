const BASE64URL_CHARSET = /^[A-Za-z0-9_-]*$/

export function toBase64Url(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function fromBase64Url(value) {
  const normalized = String(value || '')

  if (!BASE64URL_CHARSET.test(normalized)) {
    throw new Error('Invalid base64url string: contains disallowed characters.')
  }

  const padded = normalized.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64')
}
