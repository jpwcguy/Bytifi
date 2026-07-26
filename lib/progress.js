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

  if (Number.isFinite(info.percent)) {
    segments.push(`${info.percent}%`)
  }

  if (info.detail) {
    segments.push(info.detail)
  }

  return segments.join(' · ')
}
