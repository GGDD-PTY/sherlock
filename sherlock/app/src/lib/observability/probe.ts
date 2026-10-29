// ============================================================================
// PROBE DE OBSERVABILIDAD — identidad y formato del secreto
// ============================================================================
// Lo comparten `src/lib/env.ts` (que valida el secreto al arrancar), la ruta
// `POST /api/observability/probe` y sus tests. Vive aparte por dos razones: para
// que env.ts y la ruta no se importen entre sí, y porque un archivo `route.ts`
// de Next SÓLO puede exportar los campos que el framework conoce — una
// constante compartida ahí rompe el build.
//
// Es un secreto DEDICADO y no uno reusado: el probe es la única superficie del
// producto que un operador dispara desde fuera, sin sesión y contra
// producción. Los demás secretos de servidor (`WEBHOOK_SECRET`,
// `INTAKE_SERVER_SECRET`, `ADMIN_VDR_CAPABILITY_SECRET`, `CONVEX_DEPLOY_KEY`)
// son autoridad de escritura app↔Convex; aceptarlos como bearer acá le daría a
// una ruta pública el poder de escribir en la base si el valor se filtrara por
// un log, un proxy o un curl mal escrito. Sin esta variable la ruta responde
// 404 y el radio de daño del probe es exactamente "forzar un 5xx sintético".
// ============================================================================

import { Schema } from 'effect'

const OBSERVABILITY_PROBE_SECRET_MIN_LENGTH = 32
const OBSERVABILITY_PROBE_SECRET_MAX_LENGTH = 4_096

// La forma del secreto se declara una vez y la comparten el arranque
// (`src/lib/env.ts`), la ruta y sus pruebas.
const ObservabilityProbeSecretSchema = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(OBSERVABILITY_PROBE_SECRET_MIN_LENGTH),
    Schema.isMaxLength(OBSERVABILITY_PROBE_SECRET_MAX_LENGTH)
  )
)

export const isValidObservabilityProbeSecret = Schema.is(ObservabilityProbeSecretSchema)

/** El secreto configurado, o `null` si falta o no cumple el formato. */
export function resolveObservabilityProbeSecret(
  value: string | undefined = process.env.OBSERVABILITY_PROBE_SECRET
): string | null {
  return value && isValidObservabilityProbeSecret(value) ? value : null
}

// Ruta exacta, tal como la registra `src/proxy.ts` y como viaja al aviso.
export const OBSERVABILITY_PROBE_ROUTE = '/api/observability/probe'
// Nombre del error sintético: es la mitad de la llave de dedupe del aviso, así
// que un probe nunca se agrupa con una rotura de verdad.
export const OBSERVABILITY_PROBE_ERROR_NAME = 'SyntheticObservabilityProbe'
