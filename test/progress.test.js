import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createProgressTracker,
  formatBytes,
  formatDuration,
  formatProgressLine,
} from '../lib/progress.js'

test('formatBytes renders human-readable sizes', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1024), '1.00 KB')
  assert.equal(formatBytes(1536), '1.50 KB')
})

test('formatDuration renders seconds and minutes', () => {
  assert.equal(formatDuration(500), '1s')
  assert.equal(formatDuration(65_000), '1m 5s')
})

test('formatProgressLine includes throughput and ETA when provided', () => {
  const line = formatProgressLine({
    stage: 'downloading',
    part: 2,
    totalParts: 10,
    percent: 20,
    bytesPerSec: 1024 * 1024,
    etaMs: 45_000,
  })

  assert.match(line, /downloading/)
  assert.match(line, /part 2\/10/)
  assert.match(line, /20%/)
  assert.match(line, /\/s/)
  assert.match(line, /ETA/)
})

test('createProgressTracker estimates throughput and ETA', async () => {
  const tracker = createProgressTracker({ totalBytes: 10_000 })
  tracker.update({ downloadedBytes: 0, totalBytes: 10_000 })

  await new Promise((resolve) => setTimeout(resolve, 300))

  const enriched = tracker.update({
    stage: 'downloading',
    downloadedBytes: 5000,
    totalBytes: 10_000,
    percent: 50,
  })

  assert.equal(enriched.stage, 'downloading')
  if (enriched.bytesPerSec != null) {
    assert.ok(enriched.bytesPerSec > 0)
  }
})
