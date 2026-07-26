export const DEFAULT_BASE_URL = 'https://bytifi.com'

export function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
}

export function validateBaseUrl(url) {
  const normalized = normalizeBaseUrl(url)

  let parsed
  try {
    parsed = new URL(normalized)
  } catch {
    throw new Error(`Invalid base URL: ${url}`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Invalid base URL protocol: ${parsed.protocol} (use http: or https:)`)
  }

  if (!parsed.hostname) {
    throw new Error('Invalid base URL: missing hostname.')
  }

  return normalized
}
