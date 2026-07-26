import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_BASE_URL, normalizeBaseUrl, validateBaseUrl } from '../lib/url.js'

test('normalizeBaseUrl strips trailing slashes', () => {
  assert.equal(normalizeBaseUrl('https://bytifi.com/'), 'https://bytifi.com')
  assert.equal(normalizeBaseUrl('https://bytifi.com///'), 'https://bytifi.com')
})

test('normalizeBaseUrl uses default when empty', () => {
  assert.equal(normalizeBaseUrl(''), DEFAULT_BASE_URL)
  assert.equal(normalizeBaseUrl(undefined), DEFAULT_BASE_URL)
})

test('validateBaseUrl accepts http and https', () => {
  assert.equal(validateBaseUrl('https://bytifi.com'), 'https://bytifi.com')
  assert.equal(validateBaseUrl('http://localhost:3000/'), 'http://localhost:3000')
})

test('validateBaseUrl rejects invalid URLs', () => {
  assert.throws(() => validateBaseUrl('not-a-url'), /Invalid base URL/)
  assert.throws(() => validateBaseUrl('ftp://files.example.com'), /Invalid base URL protocol/)
})
