import { Option, Schema } from 'effect'

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Installation URLs are origins, with HTTPS required outside local development. */
export function parseAppOrigin(value: string, production: boolean): string | null {
  const parsed = decodeUrl(value.trim())
  if (Option.isNone(parsed)) return null
  const url = parsed.value
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (production && loopback) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && !production))
  ) {
    return null
  }
  return url.origin
}
