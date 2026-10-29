import { Option, Schema } from 'effect'

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

/** A deployment must explicitly configure every destination-bearing email setting. */
export function getEmailConfiguration(): { from: string; appOrigin: string } | null {
  const from = process.env.RESEND_FROM_EMAIL?.trim()
  const appUrl = process.env.APP_URL?.trim()
  if (!process.env.RESEND_API_KEY?.trim() || !from || !appUrl || /[\r\n]/.test(from)) {
    return null
  }
  const production = process.env.CONVEX_ENV === 'production'
  if (production && process.env.RESEND_TEST_MODE !== 'false') return null
  const parsed = decodeUrl(appUrl)
  if (Option.isNone(parsed)) return null
  const url = parsed.value
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (production && local) ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !production))
  ) {
    return null
  }
  return { from, appOrigin: url.origin }
}
