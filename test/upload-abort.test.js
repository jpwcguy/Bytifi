import assert from 'node:assert/strict'
import test from 'node:test'

test('AbortSignal.any rejects undefined signal entries', () => {
  assert.throws(
    () => AbortSignal.any([undefined, new AbortController().signal]),
    (error) => error instanceof TypeError,
  )
})

test('AbortSignal.any accepts a single worker signal without a caller signal', () => {
  const worker = new AbortController()
  const combined = AbortSignal.any([worker.signal])
  assert.equal(combined.aborted, false)
  worker.abort()
  assert.equal(combined.aborted, true)
})
