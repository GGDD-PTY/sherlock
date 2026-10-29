// ============================================================================
// ORÍGENES EXTRA DE LA CSP PARA UN BACKEND CONVEX LOCAL (`bun run dev:local`)
// ============================================================================
// La CSP de `next.config.ts` permite `https://*.convex.cloud` y
// `wss://*.convex.cloud`. En modo local (`scripts/convex-local.mjs`) la app
// apunta `NEXT_PUBLIC_CONVEX_URL` a `http://127.0.0.1:3210`, y Chrome bloquea
// `ws://127.0.0.1:3210/api/…/sync`: la sala renderiza desde SSR pero ningún
// query ni mutation del cliente llega. Este helper deriva los orígenes que hay
// que sumar, y SOLO cuando se cumplen las TRES condiciones a la vez: el build
// no es de producción, el caller dice `isDev` y el host es loopback. Con una
// URL de la nube, o fuera de dev, devuelve listas vacías y la CSP de producción
// queda byte por byte igual.
//
// El `NODE_ENV !== 'production'` es propio de este módulo, no del caller: hoy
// `next.config.ts` deriva `isDev` de `NODE_ENV === 'development'`, pero eso es
// un `boolean` que cualquiera puede pasar en `true`. Con el candado acá, un
// build de producción no puede abrir la CSP a loopback ni por error de caller.
// ============================================================================

import { Option, Schema } from 'effect'

const LoopbackHostSchema = Schema.Literals(['127.0.0.1', 'localhost', '[::1]'])
const isLoopbackHost = Schema.is(LoopbackHostSchema)

const decodeUrl = Schema.decodeUnknownOption(Schema.URLFromString)

export type LocalConvexCspOrigins = {
  /** `connect-src`: http + ws del backend y, si existe, del site URL local. */
  connectSrc: string[]
  /** `img-src`: solo el backend (logos de empresa via `ctx.storage.getUrl`),
   *  el gesamplefoods local de `https://*.convex.cloud` que ya está en producción. */
  imgSrc: string[]
}

const NONE: LocalConvexCspOrigins = { connectSrc: [], imgSrc: [] }

function loopbackHttpOrigin(value: string | undefined): string | null {
  if (!value) return null
  const parsed = decodeUrl(value)
  if (Option.isNone(parsed)) return null
  const url = parsed.value
  if (url.protocol !== 'http:' || !isLoopbackHost(url.hostname)) return null
  return url.origin
}

export function localConvexCspOrigins(args: {
  isDev: boolean
  convexUrl: string | undefined
  convexSiteUrl: string | undefined
}): LocalConvexCspOrigins {
  if (process.env.NODE_ENV === 'production') return NONE
  if (!args.isDev) return NONE
  const backend = loopbackHttpOrigin(args.convexUrl)
  if (!backend) return NONE

  const connectSrc = [backend, backend.replace(/^http:/, 'ws:')]
  const site = loopbackHttpOrigin(args.convexSiteUrl)
  if (site && site !== backend) connectSrc.push(site, site.replace(/^http:/, 'ws:'))

  return { connectSrc, imgSrc: [backend] }
}

/** Suma orígenes a una directiva; con la lista vacía devuelve la directiva tal
 *  cual, sin un espacio de más. */
export function withCspOrigins(directive: string, origins: readonly string[]): string {
  return [directive, ...origins].join(' ')
}
