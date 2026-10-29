// ============================================================================
// ROADMAP PÚBLICO — superficie deliberadamente sin auth
// ============================================================================
// La página /roadmap es pública y el votante no tiene sesión que ofrecer, así
// que estas funciones omiten `requireAuth` A PROPÓSITO. No es un descuido ni
// una excepción pendiente de cerrar: pedir login aquí mataría la única señal
// que la página existe para recoger.
//
// Lo que acota el abuso no es la identidad, es el diseño. El registry de
// features es una lista cerrada, cada dispositivo reparte tres votos entre
// funciones distintas, los breakers cortan el total por feature y la cola
// global de peticiones, y nada se publica sin curaduría manual del equipo.
//
// No se lee ni se escribe nada sensible: sin perfiles, sin empresas, sin
// documentos, sin ids de otras tablas. El peor caso es ruido en una cola que
// un humano revisa antes de que llegue a la vista de nadie.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import { mutation, query, type MutationCtx, type QueryCtx } from './_generated/server'
import { convexPromise, runConvex } from './_helpers/effect'
import { AppError, ErrorCode, rateLimitExceeded, validationFailed } from './_helpers/errors'
import {
  FEATURE_TOTAL_BREAKER,
  REQUESTS_GLOBAL_BREAKER,
  REQUESTS_PER_DEVICE_PER_DAY,
  VOTED_FEATURES_CAP,
  isValidDeviceToken,
  normalizeRequestBody,
  normalizedDedupeKey,
} from './_roadmap/model'
import { isKnownKey, isVotableKey } from './_roadmap/registry'

const DAY_MS = 24 * 60 * 60 * 1000

const getVoteTotalsProgram = Effect.fn('Roadmap.getVoteTotals')(function* (ctx: QueryCtx) {
  const totals: Record<string, number> = {}

  // `.collect()` es seguro porque sólo las claves del registry llegan a tener
  // fila: el techo de la tabla es el tamaño del registry, no el tráfico.
  const rows = yield* convexPromise(() => ctx.db.query('roadmapVoteTotals').collect())
  for (const row of rows) {
    if (!isKnownKey(row.featureKey)) continue
    totals[row.featureKey] = row.total
  }

  return totals
})

export const getVoteTotals = query({
  args: {},
  handler: (ctx) => runConvex(getVoteTotalsProgram(ctx)),
})

// Sin esta query el tablero no sabe qué votó ya este dispositivo y pinta cada
// botón como disponible: al recargar, el visitante vuelve a ver todo votable y
// el tope sólo aparece cuando el servidor rechaza el clic. El presupuesto tiene
// que ser visible ANTES de gastarlo, no después.
const getDeviceVotesProgram = Effect.fn('Roadmap.getDeviceVotes')(function* (
  ctx: QueryCtx,
  args: { deviceToken: string }
) {
  // Un token inválido no es un error del visitante que valga la pena
  // propagar: la página es pública y una query que lanza deja el tablero en
  // blanco. Se responde "no has votado nada", que es la verdad.
  if (!isValidDeviceToken(args.deviceToken)) {
    return { featureKeys: [], remaining: VOTED_FEATURES_CAP, cap: VOTED_FEATURES_CAP }
  }

  const rows = yield* convexPromise(() =>
    ctx.db
      .query('roadmapVotes')
      .withIndex('by_device', (q) => q.eq('deviceToken', args.deviceToken))
      .collect()
  )

  // Cuenta TODAS las filas del dispositivo, no sólo las votables. Cuando una
  // función sale de la lista votable, su voto viejo sigue ocupando
  // presupuesto: filtrarlo aquí le regalaba un voto extra al dispositivo en
  // cada corte de alcance.
  const featureKeys = rows.map((row) => row.featureKey)

  return {
    featureKeys,
    remaining: Math.max(0, VOTED_FEATURES_CAP - featureKeys.length),
    cap: VOTED_FEATURES_CAP,
  }
})

export const getDeviceVotes = query({
  args: { deviceToken: v.string() },
  handler: (ctx, args) => runConvex(getDeviceVotesProgram(ctx, args)),
})

const voteProgram = Effect.fn('Roadmap.vote')(function* (
  ctx: MutationCtx,
  args: { featureKey: string; deviceToken: string }
) {
  // Sin `requireAuth`: la página es pública. El presupuesto por dispositivo y
  // el breaker por feature son el límite, no el login.
  if (!isValidDeviceToken(args.deviceToken)) {
    return yield* Effect.fail(
      validationFailed('Identificador de dispositivo inválido.', 'deviceToken')
    )
  }

  const own = yield* convexPromise(() =>
    ctx.db
      .query('roadmapVotes')
      .withIndex('by_device', (q) => q.eq('deviceToken', args.deviceToken))
      .collect()
  )

  const existing = own.find((row) => row.featureKey === args.featureKey)

  // El gate de votabilidad sólo cubre el voto NUEVO. Quitar uno que ya existe
  // funciona aunque la función haya salido de la lista votable: si no, la fila
  // vieja se queda pegada, gastando presupuesto que nadie puede liberar.
  if (!existing && !isVotableKey(args.featureKey)) {
    return yield* Effect.fail(validationFailed('Esta función no admite votos.', 'featureKey'))
  }

  const totals = yield* convexPromise(() =>
    ctx.db
      .query('roadmapVoteTotals')
      .withIndex('by_feature', (q) => q.eq('featureKey', args.featureKey))
      .unique()
  )

  if (existing) {
    // Quitar el voto. Se resta el peso REAL de la fila, no 1: las filas del
    // modelo viejo pesan hasta 3 y restar 1 dejaría huérfano el resto en el
    // total público.
    const weight = existing.count ?? 1
    yield* convexPromise(() => ctx.db.delete(existing._id))
    if (totals) {
      yield* convexPromise(() =>
        ctx.db.patch(totals._id, { total: Math.max(0, totals.total - weight) })
      )
    }

    const left = own.filter((row) => row._id !== existing._id)
    return {
      accepted: true,
      voted: false,
      remaining: Math.max(0, VOTED_FEATURES_CAP - left.length),
    }
  }

  const spent = own.length
  if (spent >= VOTED_FEATURES_CAP) {
    // No es un error: el visitante gastó su presupuesto y el tablero se lo
    // dice. Lanzar aquí obligaría al cliente a distinguir "tope" de "caída".
    return { accepted: false, voted: false, remaining: 0 }
  }

  if (totals && totals.total >= FEATURE_TOTAL_BREAKER) {
    return yield* Effect.fail(rateLimitExceeded())
  }

  yield* convexPromise(() =>
    ctx.db.insert('roadmapVotes', {
      featureKey: args.featureKey,
      deviceToken: args.deviceToken,
      updatedAt: Date.now(),
    })
  )

  if (totals) {
    yield* convexPromise(() => ctx.db.patch(totals._id, { total: totals.total + 1 }))
  } else {
    yield* convexPromise(() =>
      ctx.db.insert('roadmapVoteTotals', { featureKey: args.featureKey, total: 1 })
    )
  }

  return { accepted: true, voted: true, remaining: VOTED_FEATURES_CAP - (spent + 1) }
})

export const vote = mutation({
  args: { featureKey: v.string(), deviceToken: v.string() },
  handler: (ctx, args) => runConvex(voteProgram(ctx, args)),
})

const submitFeatureRequestProgram = Effect.fn('Roadmap.submitFeatureRequest')(function* (
  ctx: MutationCtx,
  args: { body: string; locale: 'es'; deviceToken: string }
) {
  if (!isValidDeviceToken(args.deviceToken)) {
    return yield* Effect.fail(
      validationFailed('Identificador de dispositivo inválido.', 'deviceToken')
    )
  }

  const body = normalizeRequestBody(args.body)
  if (body.length === 0) {
    return yield* Effect.fail(validationFailed('Escribe tu petición antes de enviarla.', 'body'))
  }

  const recent = yield* convexPromise(() =>
    ctx.db
      .query('roadmapFeatureRequests')
      .withIndex('by_device_created', (q) => q.eq('deviceToken', args.deviceToken))
      .order('desc')
      .take(REQUESTS_PER_DEVICE_PER_DAY)
  )

  if (recent.length === REQUESTS_PER_DEVICE_PER_DAY) {
    // El orden es descendente, así que la fila más VIEJA de la ventana es la
    // última: si hasta ella cabe en 24h, el cupo del día ya se gastó.
    const oldest = recent[recent.length - 1]
    if (oldest.createdAt > Date.now() - DAY_MS) {
      return yield* Effect.fail(
        new AppError(
          ErrorCode.RATE_LIMIT_EXCEEDED,
          'Ya enviaste varias peticiones hoy; intenta mañana.'
        )
      )
    }
  }

  const queued = yield* convexPromise(() =>
    ctx.db
      .query('roadmapFeatureRequests')
      .withIndex('by_status', (q) => q.eq('status', 'NEW'))
      .take(REQUESTS_GLOBAL_BREAKER)
  )

  if (queued.length >= REQUESTS_GLOBAL_BREAKER) {
    return yield* Effect.fail(rateLimitExceeded())
  }

  // Sólo el duplicado EXACTO — misma clave de tema — se le reporta al
  // visitante, y sólo cuando de verdad no se guardó nada nuevo. Aquí vivía un
  // barrido difuso que le decía "ya hay una parecida; las agrupamos" a
  // peticiones que sí se habían guardado y que nadie agrupaba: `GROUPED` es
  // un estado que ninguna función escribe. Agrupar es trabajo del curador
  // humano, así que el tablero ya no lo promete.
  const dedupeKey = normalizedDedupeKey(body)
  const exact = yield* convexPromise(() =>
    ctx.db
      .query('roadmapFeatureRequests')
      .withIndex('by_normalized', (q) => q.eq('normalizedBody', dedupeKey))
      .first()
  )

  if (exact && exact.status !== 'DISMISSED') {
    return { stored: false, duplicate: true }
  }

  yield* convexPromise(() =>
    ctx.db.insert('roadmapFeatureRequests', {
      body,
      normalizedBody: dedupeKey,
      locale: args.locale,
      deviceToken: args.deviceToken,
      status: 'NEW',
      createdAt: Date.now(),
    })
  )

  return { stored: true, duplicate: false }
})

// El sitio ships solo en español ([F] 2026-09-03 23:30): el validador acepta
// `es` y nada más, así que un idioma inventado se cae en la frontera de Convex
// y no llega a la cola. El campo se conserva porque las filas viejas lo traen y
// el curador humano lo lee.
export const submitFeatureRequest = mutation({
  args: { body: v.string(), locale: v.literal('es'), deviceToken: v.string() },
  handler: (ctx, args) => runConvex(submitFeatureRequestProgram(ctx, args)),
})
