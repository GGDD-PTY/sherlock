// ============================================================================
// IDENTIDAD DEV → CONVEX LOCAL (`bun run dev:local`)
// ============================================================================
// En dev-auth el cliente Convex no manda token (no hay JWT que el backend
// pueda validar), así que `requireAuth` resuelve TODA llamada al usuario de
// bypass `admin@dev.local`, sea cual sea el usuario elegido en `/dev-login`.
// Contra la sala del cliente eso pega en `requireAdminVdrCapability`: un
// ADMIN sin capability WorkOS se rechaza (`AUTHZ_UNAUTHORIZED`), y una
// capability no se puede acuñar sin sesión WorkOS. El backend local sí
// admite el mecanismo de Convex para dev: `setAdminAuth(adminKey, identity)`
// («acting as»), el mismo que usa `convex run --identity`.
//
// Esto se enciende SOLO cuando `scripts/convex-local.mjs` exporta la admin
// key del backend anónimo (`NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY`) y la URL de
// Convex es loopback. Contra la nube (aunque dev-auth esté activo) no hay
// key, no hay impersonación y todo sigue como antes. Es un mecanismo de
// desarrollo: la key es la del backend que vive en 127.0.0.1 de esta máquina.
// ============================================================================

import { Option, Schema } from 'effect'

import { DEV_AUTH_ENABLED } from './config'
import type { DevUser } from './types'

type LocalConvexEnv = {
  NODE_ENV?: string
  NEXT_PUBLIC_CONVEX_URL?: string
  NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY?: string
}

function readLocalConvexEnv(): LocalConvexEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_CONVEX_URL: process.env.NEXT_PUBLIC_CONVEX_URL,
    NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY: process.env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY,
  }
}

// Las dos condiciones que abren la impersonación se escriben como schema, con
// nombre. Es un candado, no un formateo: si `isLoopbackConvexUrl` acepta un
// host de más, la admin key de un backend local sale hacia otra parte.
const LoopbackHostSchema = Schema.Literals(['127.0.0.1', 'localhost', '[::1]'])
const PlainHttpProtocolSchema = Schema.Literals(['http:'])
// La key vacía o de solo espacios no es una key.
const AdminKeySchema = Schema.String.pipe(Schema.check(Schema.isMinLength(1)))

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)
const isLoopbackHost = Schema.is(LoopbackHostSchema)
const isPlainHttpProtocol = Schema.is(PlainHttpProtocolSchema)
const isAdminKey = Schema.is(AdminKeySchema)

/** Identidad con la forma que `_helpers/auth.identity.ts` sabe resolver:
 *  `issuer` decide el proveedor y `subject` es el id que la tabla `users`
 *  guarda para ese proveedor. */
export type LocalConvexIdentity = {
  subject: string
  issuer: string
  sid?: string
  email: string
  name: string
}

export function isLoopbackConvexUrl(convexUrl: string | undefined): boolean {
  if (!convexUrl) return false

  const url = decodeUrl(convexUrl)
  if (Option.isNone(url)) return false

  return isPlainHttpProtocol(url.value.protocol) && isLoopbackHost(url.value.hostname)
}

/** La admin key del backend local, o null cuando no toca impersonar. */
export function localConvexAdminKey(env: LocalConvexEnv, devAuthEnabled: boolean): string | null {
  if (!devAuthEnabled || env.NODE_ENV === 'production') return null
  if (!isLoopbackConvexUrl(env.NEXT_PUBLIC_CONVEX_URL)) return null
  const key = env.NEXT_PUBLIC_CONVEX_LOCAL_ADMIN_KEY?.trim()
  return isAdminKey(key) ? key : null
}

export function hasLocalConvexIdentity(
  env: LocalConvexEnv = readLocalConvexEnv(),
  devAuthEnabled: boolean = DEV_AUTH_ENABLED
): boolean {
  return localConvexAdminKey(env, devAuthEnabled) !== null
}

// Fixtures solo con dev-auth y sin backend local (bun run dev contra la nube
// sin admin). Con la key y URL loopback se lee Convex de verdad.
export function useDevAuthFixtures(
  env: LocalConvexEnv = readLocalConvexEnv(),
  devAuthEnabled: boolean = DEV_AUTH_ENABLED
): boolean {
  return devAuthEnabled && !hasLocalConvexIdentity(env, devAuthEnabled)
}

export function localConvexIdentity(user: DevUser): LocalConvexIdentity {
  return {
    subject: user.convexIdentity.subject,
    issuer: user.convexIdentity.issuer,
    ...(user.convexIdentity.sessionId ? { sid: user.convexIdentity.sessionId } : {}),
    email: user.email,
    name: user.name,
  }
}
