// ============================================================================
// INTAKE DEMO MODE — EL PROGRAMA EFFECT DE LA BANDERA
// ============================================================================
// La bandera se resuelve con `Config` sobre un `ConfigProvider` armado a mano,
// para que el valor inyectado en una prueba y el de `process.env` pasen por el
// mismo parse exacto (`value === 'true'`, default apagado).
//
// ===== POR QUÉ VIVE APARTE DE `config.ts` ([F] 2026-09-08) =====
// `config.ts` solo declara `INTAKE_CSRF_HEADER`, una string, y la importan tres
// componentes `'use client'` — la landing, el workspace temporal y la sala de
// documentos. Tener este programa en ese mismo módulo metía `Config`,
// `ConfigProvider`, `Effect` y `Schema` en el first-load JS de la landing y de
// las dos salas. Nada cambió de comportamiento: el programa entero se mudó acá
// tal cual, y sus consumidores son todos de servidor (proxy, rutas /api,
// Server Components y el callback de auth).
// ============================================================================

import { Config, ConfigProvider, Effect, Schema } from 'effect'

const intakeDemoModeConfig = Config.schema(
  Schema.UndefinedOr(Schema.String),
  'INTAKE_DEMO_MODE'
).pipe(Config.map((value) => value === 'true'))

function intakeConfigProvider(value: string | undefined): ConfigProvider.ConfigProvider {
  return ConfigProvider.fromEnvRecord(
    { INTAKE_DEMO_MODE: value ?? process.env.INTAKE_DEMO_MODE },
    { preserveEmptyStrings: true }
  )
}

const isIntakeDemoModeEnabledEffect = Effect.fn('IntakeDemoMode.isEnabled')(function* (
  value?: string
) {
  return yield* intakeDemoModeConfig.parse(intakeConfigProvider(value))
})

// Puente síncrono para las rutas, proxy y Server Components existentes.
export function isIntakeDemoModeEnabled(value?: string): boolean {
  return Effect.runSync(isIntakeDemoModeEnabledEffect(value))
}
