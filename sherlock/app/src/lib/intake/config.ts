import { Effect } from 'effect'

// Una sola constante, sin frontera que decodificar ni lista que recorrer: un
// `Schema` acá sería ceremonia (ver AGENTS.md de src/lib, "Effect no se
// retira por ceremonia" no aplica al revés — no hay nada que decodificar).
// El envoltorio de abajo es el último recurso del brief de llenado (paso 6):
// no cambia el valor exportado ni su tipo, solo lo hace correr por Effect.
// Candidato a recorte, ver reporte del lote. Lo importan tres componentes
// `'use client'`; la bandera de demo —que sí necesita `Config` y un
// `ConfigProvider`— vive en `@/lib/intake/demo-mode`.
export const INTAKE_CSRF_HEADER = Effect.runSync(Effect.sync(() => 'x-intake-csrf' as const))
