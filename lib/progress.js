export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '0 B'

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  const digits = size >= 100 || unitIndex === 0 ? 0 : size >= 10 ? 1 : 2
  return `${size.toFixed(digits)} ${units[unitIndex]}`
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(1, Math.ceil(Number(ms) / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
}

export function createProgressTracker({ totalBytes = null } = {}) {
  let lastBytes = 0
  let lastTime = Date.now()
  let smoothedBytesPerSec = 0

  return {
    update(info = {}) {
      const now = Date.now()
      const bytes = Number(info.downloadedBytes ?? info.bytes ?? 0)
      const elapsedMs = now - lastTime

      if (elapsedMs >= 250 && bytes >= lastBytes) {
        const instantRate = ((bytes - lastBytes) / elapsedMs) * 1000
        smoothedBytesPerSec = smoothedBytesPerSec === 0
          ? instantRate
          : smoothedBytesPerSec * 0.7 + instantRate * 0.3
        lastBytes = bytes
        lastTime = now
      }

      const total = Number(info.totalBytes ?? totalBytes)
      let etaMs = null

      if (Number.isFinite(total) && total > bytes && smoothedBytesPerSec > 0) {
        etaMs = Math.round(((total - bytes) / smoothedBytesPerSec) * 1000)
      }

      return {
        ...info,
        bytesPerSec: smoothedBytesPerSec > 0 ? smoothedBytesPerSec : undefined,
        etaMs: etaMs ?? undefined,
      }
    },

    reset() {
      lastBytes = 0
      lastTime = Date.now()
      smoothedBytesPerSec = 0
    },
  }
}

export function formatProgressLine(info) {
  if (typeof info === 'number') {
    return `${info}%`
  }

  if (!info || typeof info !== 'object') {
    return ''
  }

  if (info.stage === 'waiting') {
    return info.message || 'Waiting…'
  }

  const segments = []

  if (info.part && info.totalParts) {
    segments.push(`part ${info.part}/${info.totalParts}`)
  }

  if (info.stage) {
    segments.push(info.stage)
  }

  if (info.partBytes) {
    segments.push(formatBytes(info.partBytes))
  }

  if (Number.isFinite(info.downloadedBytes) && Number.isFinite(info.totalBytes)) {
    segments.push(`${formatBytes(info.downloadedBytes)}/${formatBytes(info.totalBytes)}`)
  }

  if (Number.isFinite(info.bytesPerSec) && info.bytesPerSec > 0) {
    segments.push(`${formatBytes(info.bytesPerSec)}/s`)
  }

  if (Number.isFinite(info.etaMs) && info.etaMs > 0) {
    segments.push(`ETA ${formatDuration(info.etaMs)}`)
  }

  if (Number.isFinite(info.percent)) {
    segments.push(`${info.percent}%`)
  }

  if (info.detail) {
    segments.push(info.detail)
  }

  return segments.join(' · ')
}
