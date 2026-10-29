import { Schema } from 'effect'

const AUTH_MD_ISSUER_INVALID = 'AUTH_MD_ISSUER_INVALID'

/**
 * El issuer de OAuth configurado no sirve para publicar `/auth.md`. Error
 * tipado en vez de `Error` pelado: `next.config.ts` falla el arranque igual,
 * pero quien lo atrape distingue esta causa por `_tag` sin leer el mensaje.
 * `reason` dice cuál de las dos puertas se cerró — parseo o forma — sin que el
 * valor configurado viaje dentro del error.
 */
class AuthMdIssuerInvalidError extends Schema.TaggedError<AuthMdIssuerInvalidError>()(
  'AuthMdIssuerInvalidError',
  {
    reason: Schema.Literals(['unparseable', 'unsafe']),
    message: Schema.String,
  }
) {}

export function agentAuthMdRewrite(
  issuer: string | undefined,
  mcpSurfaceEnabled = true
): { source: '/auth.md'; destination: string } | null {
  if (!mcpSurfaceEnabled) return null

  let url: URL
  try {
    url = new URL(issuer ?? '')
  } catch {
    throw new AuthMdIssuerInvalidError({
      reason: 'unparseable',
      message: AUTH_MD_ISSUER_INVALID,
    })
  }
  const loopbackHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  if (
    (url.protocol !== 'https:' && !loopbackHttp) ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new AuthMdIssuerInvalidError({ reason: 'unsafe', message: AUTH_MD_ISSUER_INVALID })
  }
  return { source: '/auth.md', destination: `${url.origin}/agent/auth.md` }
}
