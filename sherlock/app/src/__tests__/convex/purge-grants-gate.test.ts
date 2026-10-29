// ============================================================================
// PURGE-GRANTS GATE TEST (convex/_documents/internals.ts)
// ============================================================================
// El cron `purge-expired-document-grants` hard-deletea documentAccessGrants
// expirados. Tras revivir la ref rota del cron, el backlog acumulado NO debe
// barrerse solo: la purga queda gateada tras el env GRANT_PURGE_FLOOR_MS.
// Este test fija el contrato de decisión del gate (resolvePurgeFloorMs):
//   - sin env / vacío / inválido -> null  => el handler hace skip (cero borrado)
//   - epoch ms válido            -> number => piso de purga aplicado
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest'
import { resolvePurgeFloorMs } from '../../../convex/_documents/internals'

const ENV_KEY = 'GRANT_PURGE_FLOOR_MS'

function setFloor(value: string | undefined) {
  if (value === undefined) {
    delete process.env[ENV_KEY]
  } else {
    process.env[ENV_KEY] = value
  }
}

describe('resolvePurgeFloorMs (gate del backlog de purga)', () => {
  afterEach(() => {
    delete process.env[ENV_KEY]
  })

  it('sin env configurado -> null (gate activo, no se purga nada)', () => {
    setFloor(undefined)
    expect(resolvePurgeFloorMs()).toBeNull()
  })

  it('string vacío -> null', () => {
    setFloor('')
    expect(resolvePurgeFloorMs()).toBeNull()
  })

  it('solo espacios -> null', () => {
    setFloor('   ')
    expect(resolvePurgeFloorMs()).toBeNull()
  })

  it('valor no numérico -> null (no habilita por error de tipeo)', () => {
    setFloor('mañana')
    expect(resolvePurgeFloorMs()).toBeNull()
  })

  it('"0" -> 0 (drena todo el backlog con retención normal)', () => {
    setFloor('0')
    expect(resolvePurgeFloorMs()).toBe(0)
  })

  it('epoch ms válido -> el mismo número (piso prospectivo)', () => {
    setFloor('1700000000000')
    expect(resolvePurgeFloorMs()).toBe(1_700_000_000_000)
  })
})
