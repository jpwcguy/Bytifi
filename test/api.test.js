import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRetryAfterMs } from '../lib/api.js'

function responseWithHeaders(headers) {
  return {
    headers: {
      get(name) {
        const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
        return key ? headers[key] : null
      },
    },
  }
}

test('parseRetryAfterMs prefers Retry-After seconds', () => {
  const ms = parseRetryAfterMs(responseWithHeaders({ 'Retry-After': '12' }))
  assert.equal(ms, 12_000)
})

test('parseRetryAfterMs treats RateLimit-Reset over 1e12 as absolute milliseconds', () => {
  const resetAt = Date.now() + 45_000
  const ms = parseRetryAfterMs(responseWithHeaders({ 'RateLimit-Reset': String(resetAt) }))
  assert.ok(ms >= 40_000 && ms <= 45_000, `expected ~45s wait, got ${ms}`)
})

test('parseRetryAfterMs treats RateLimit-Reset over 1e9 as absolute seconds', () => {
  const resetAtSec = Math.floor(Date.now() / 1000) + 30
  const ms = parseRetryAfterMs(responseWithHeaders({ 'RateLimit-Reset': String(resetAtSec) }))
  assert.ok(ms >= 25_000 && ms <= 30_000, `expected ~30s wait, got ${ms}`)
})

test('parseRetryAfterMs treats small RateLimit-Reset as relative seconds', () => {
  const ms = parseRetryAfterMs(responseWithHeaders({ 'RateLimit-Reset': '5' }))
  assert.equal(ms, 5_000)
})
