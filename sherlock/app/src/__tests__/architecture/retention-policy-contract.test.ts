// ============================================================================
// CONTRATO DE RETENCIÓN — el cron no puede borrar antes de lo prometido
// ============================================================================
// La política de privacidad publicada es una promesa al titular de los datos.
// Los crons de limpieza son la implementación de esa promesa, y hasta
// 2026-07-26 la contradecían: borraban bitácoras del VDR a los 90 días y
// activity logs a los 180, mientras la política publicada promete 5 años por
// su función probatoria. Este contrato ejecuta esa correspondencia para que
// no vuelva a divergir en silencio.
// ============================================================================

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = process.cwd()
const cronHandlersSource = readFileSync(join(appRoot, 'convex/cronHandlers.ts'), 'utf8')
const privacySource = readFileSync(
  join(appRoot, 'src/app/[locale]/(public)/privacy/page.tsx'),
  'utf8'
)

const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000

/** Evalúa una expresión aritmética del tipo `5 * 365 * DAY_MS` declarada en RETENTION_MS. */
function retentionMsFor(key: string): number {
  const match = cronHandlersSource.match(new RegExp(`${key}:\\s*([^,\\n]+),`))
  if (!match) throw new Error(`RETENTION_MS.${key} no está declarado en cronHandlers.ts`)
  const factors = match[1]
    .split('*')
    .map((factor) => factor.trim())
    .map((factor) => (factor === 'DAY_MS' ? 24 * 60 * 60 * 1000 : Number(factor)))
  expect(factors.every((factor) => Number.isFinite(factor))).toBe(true)
  return factors.reduce((total, factor) => total * factor, 1)
}

describe('contrato de retención (cron ↔ política publicada)', () => {
  it('conserva las bitácoras de acceso al VDR los 5 años que promete la política', () => {
    expect(retentionMsFor('documentAccessLogs')).toBe(FIVE_YEARS_MS)
    expect(privacySource).toContain('Bitácoras de acceso a documentos (VDR) y registros de')
    expect(privacySource).toContain('5 años, por su función probatoria')
  })

  it('conserva los registros de actividad los mismos 5 años', () => {
    expect(retentionMsFor('activityLogs')).toBe(FIVE_YEARS_MS)
  })

  it('purga pronto lo que no es prueba de nada: notificaciones ya leídas', () => {
    expect(retentionMsFor('readNotifications')).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('nunca borra solicitudes de eliminación: son la prueba del derecho ejercido', () => {
    expect(cronHandlersSource).not.toMatch(
      /query\('deletionRequests'\)[\s\S]{0,400}?ctx\.db\.delete/
    )
  })
})
