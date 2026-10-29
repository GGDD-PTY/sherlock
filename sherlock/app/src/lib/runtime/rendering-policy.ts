import { Schema } from 'effect'

// El catálogo de modos es un `Schema.Literals`: `satisfies` ya obliga a que
// cada `mode` de `routeGroups` pertenezca a la unión al compilar, pero un
// `as` en otro archivo podría burlarlo. El guard de abajo lo repite en
// runtime, recorriendo `.literals`, así que un modo fuera del catálogo revienta
// al cargar el módulo en vez de colarse silenciosamente en producción.
const RenderingPolicyModeSchema = Schema.Literals([
  'static_or_isr',
  'authenticated_dynamic',
  'client_exception',
])
export type RenderingPolicyMode = typeof RenderingPolicyModeSchema.Type

export const RENDERING_POLICY_REGISTRY = {
  routeGroups: {
    marketing: {
      mode: 'static_or_isr',
      description: 'Public discovery and marketing routes should default to cacheable output.',
    },
    app: {
      mode: 'authenticated_dynamic',
      description:
        'Authenticated product routes can be dynamic when they serve user-specific data.',
    },
    clientOnly: {
      mode: 'client_exception',
      description:
        'Client-only rendering is an exception and must be justified by browser-only needs.',
    },
  } satisfies Record<string, { mode: RenderingPolicyMode; description: string }>,
  thresholds: {
    // 23→18 (2026-07-24, tier b T9): post-desembebido de motor (rutas
    // analisis/valuacion, cluster labs/fusion, i18n de motor fuera en
    // T4-T8) el conteo real bajo a 18 — ratchet apretado a la realidad.
    // El VDR guest no contiene estado por request: el bearer vive en el
    // fragmento (nunca llega al servidor) y la autorización ocurre en APIs
    // cliente. Se retiró su force-dynamic redundante; el ratchet queda en 18.
    maxForceDynamicRoutes: 18,
    // 42→44 (2026-07-23): main quedó en 44 tras merges que entraron con CI
    // muerto por billing; ratchet realineado a la realidad. Auditar los 2
    // imports extra quedó en PENDING — el ratchet NO debe subir de nuevo sin
    // esa auditoría.
    // 44→38 (2026-07-24, tier b T9): post-desembebido de motor el conteo
    // real bajo a 38 — ratchet apretado, nunca aflojado.
    maxClientOnlyDynamicImports: 38,
    // Cuenta fronteras explícitas `use client`, no todos los módulos transitivos
    // del grafo cliente. Los hooks internos heredan la frontera de su consumidor.
    // 210→152 (2026-07-24, tier b T9): post-desembebido de motor (labs/
    // fusion, credits UI, analysis-engine routes) el conteo real bajó a
    // 152 — ratchet apretado a la realidad.
    // El VDR capital raise OS agregó 3 fronteras cliente reales. Sus otros 13
    // módulos nuevos heredan una frontera existente; se retiraron también 3
    // directivas redundantes previas. El presupuesto permanece en 152.
    // 152→153 (2026-08-13, firmado Reviewer): la landing /es/mycroft portada al
    // sucesor (PR #287) agrega 1 frontera cliente real (MycroftLanding).
    maxClientEntryPoints: 153,
  },
  unsupportedSurfacedAgents: ['room-analyst'] as const,
} as const

const isRenderingPolicyMode = Schema.is(RenderingPolicyModeSchema)

for (const [routeGroup, policy] of Object.entries(RENDERING_POLICY_REGISTRY.routeGroups)) {
  if (!isRenderingPolicyMode(policy.mode)) {
    throw new Error(`RENDERING_POLICY_REGISTRY.routeGroups.${routeGroup} tiene un modo inválido.`)
  }
}
