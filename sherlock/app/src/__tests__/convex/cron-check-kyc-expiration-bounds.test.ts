// ============================================================================
// CRON checkKYCExpiration — ÍNDICE by_kycStatus + LOTE, NO FULL-TABLE SCAN
// ============================================================================
// expiredKYC/expiringKYC hacían `.filter(kycStatus === 'VERIFIED' && ...).collect()`
// SIN índice y SIN cota: escaneaba TODA la tabla `profiles` (todos los roles,
// todos los estados de KYC) y traía el resultado completo a memoria en una
// sola corrida. `profiles` ya tiene `by_kycStatus` — se usa para saltar
// directo a los perfiles VERIFIED antes de filtrar por fecha, y se acota con
// `.take(100)` (lote por corrida, la siguiente corrida procesa el resto).
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkKYCExpiration } from '../../../convex/cronHandlers'
import {
  createConvexCtx,
  runHandler,
  type HarnessCtx,
  type Row,
  type Tables,
} from './nda-convex-harness'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

type QueryBuilderMock = {
  withIndex: { mock: { calls: unknown[][] } }
  filter: { mock: { calls: unknown[][] } }
  collect: { mock: { calls: unknown[] } }
  take: { mock: { calls: unknown[][] } }
}

function queryCallsFor(ctx: HarnessCtx, table: string): QueryBuilderMock[] {
  return ctx.db.query.mock.calls
    .map((call: unknown[], index: number) => ({
      table: call[0],
      builder: ctx.db.query.mock.results[index]?.value,
    }))
    .filter((entry: { table: unknown }) => entry.table === table)
    .map((entry: { builder: unknown }) => entry.builder as QueryBuilderMock)
}

function seed(): Tables {
  return {
    profiles: [
      {
        _id: 'p_expired',
        _creationTime: 1,
        userId: 'u1',
        role: 'COMPANY',
        kycStatus: 'VERIFIED',
        kycExpiresAt: NOW - DAY_MS,
      },
      {
        _id: 'p_expiring',
        _creationTime: 2,
        userId: 'u2',
        role: 'COMPANY',
        kycStatus: 'VERIFIED',
        kycExpiresAt: NOW + 5 * DAY_MS,
      },
      {
        _id: 'p_valid',
        _creationTime: 3,
        userId: 'u3',
        role: 'COMPANY',
        kycStatus: 'VERIFIED',
        kycExpiresAt: NOW + 200 * DAY_MS,
      },
      {
        _id: 'p_pending',
        _creationTime: 4,
        userId: 'u4',
        role: 'COMPANY',
        kycStatus: 'PENDING',
        kycExpiresAt: NOW - DAY_MS,
      },
    ],
    notifications: [],
  }
}

describe('cronHandlers.checkKYCExpiration — índice + lote', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('usa el índice by_kycStatus para ambas búsquedas (expirados y por expirar)', async () => {
    const ctx = createConvexCtx(seed())
    await runHandler(checkKYCExpiration, ctx, {})

    const builders = queryCallsFor(ctx, 'profiles')
    expect(builders.length).toBe(2)
    for (const builder of builders) {
      expect(builder.withIndex.mock.calls.length).toBeGreaterThan(0)
      expect(builder.withIndex.mock.calls[0][0]).toBe('by_kycStatus')
      expect(builder.take.mock.calls.length).toBeGreaterThan(0)
    }
  })

  it('nunca toca un perfil que no está VERIFIED', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables)
    await runHandler(checkKYCExpiration, ctx, {})

    const pending = tables.profiles.find((row) => row._id === 'p_pending')
    expect(pending?.kycStatus).toBe('PENDING')
  })

  it('marca EXPIRED al perfil vencido y notifica; no toca al vigente', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables)
    const result = await runHandler<
      Record<string, never>,
      { expired: number; expiringSoon: number }
    >(checkKYCExpiration, ctx, {})

    expect(result.expired).toBe(1)
    expect(result.expiringSoon).toBe(1)
    expect(tables.profiles.find((row) => row._id === 'p_expired')?.kycStatus).toBe('EXPIRED')
    expect(tables.profiles.find((row) => row._id === 'p_valid')?.kycStatus).toBe('VERIFIED')

    const notificationTitles = ctx.inserted
      .filter((entry) => entry.table === 'notifications')
      .map((entry) => entry.row.title)
    expect(notificationTitles).toContain('KYC Expirado')
    expect(notificationTitles).toContain('KYC Próximo a Expirar')
  })

  it('acota a 100 por corrida', async () => {
    const manyExpired: Row[] = Array.from({ length: 150 }, (_, i) => ({
      _id: `p_${i}`,
      _creationTime: i,
      userId: `u_${i}`,
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
      kycExpiresAt: NOW - DAY_MS - i,
    }))
    const tables: Tables = { profiles: manyExpired, notifications: [] }
    const ctx = createConvexCtx(tables)
    const result = await runHandler<Record<string, never>, { expired: number }>(
      checkKYCExpiration,
      ctx,
      {}
    )

    expect(result.expired).toBe(100)
  })
})

// ============================================================================
// Follow-up W6a-bis (verificador adversarial de #216): `expiringKYC` no tenía
// cursor. `by_kycStatus` solo indexa por `kycStatus` (y por `_creationTime`
// como desempate implícito) — no existe un índice compuesto por fecha de
// expiración, y agregarlo requeriría tocar schema.ts (fuera de alcance). Con
// el `.take(100)` original aplicado directo sobre ese orden, más de 100
// perfiles VERIFIED-en-ventana hacía que los 100 con la cuenta MÁS VIEJA
// (por `_creationTime`) se quedaran SIEMPRE con el cupo — sin importar qué
// tan cerca estuvieran de vencer perfiles 101+. Una cuenta creada después,
// pero a 1 día de que le expire el KYC, podía nunca recibir aviso.
//
// Fix: se escanea un techo mayor (deliberadamente acotado y honesto — mismo
// patrón `.take(cap+1)` centinela que el resto del archivo), y DENTRO de ese
// lote se reordena por urgencia real (`kycExpiresAt` ascendente) antes de
// recortar al cupo de notificaciones de la corrida. Esto no requiere ningún
// campo ni índice nuevo: usa el índice `by_kycStatus` que ya existe, solo
// cambia CUÁNTO se lee y en qué orden se prioriza para notificar.
// ============================================================================

describe('cronHandlers.checkKYCExpiration — expiringKYC prioriza por urgencia real, no por antigüedad de cuenta', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function starvationTables(): Tables {
    // 100 perfiles "viejos" (creados primero → primeros en el orden natural
    // del índice by_kycStatus): VERIFIED, dentro de la ventana de 30 días,
    // pero con el vencimiento más LEJANO posible dentro de esa ventana (25
    // días) — los MENOS urgentes.
    const stale: Row[] = Array.from({ length: 100 }, (_, i) => ({
      _id: `p_stale_${i}`,
      _creationTime: i,
      userId: `u_stale_${i}`,
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
      kycExpiresAt: NOW + 25 * DAY_MS,
    }))

    // 50 perfiles "nuevos" (creados después de los 100 anteriores): VERIFIED,
    // vencen en ~1 día — los MÁS urgentes. Con el orden por antigüedad de
    // cuenta (el bug), estos quedan siempre detrás de los 100 "stale" y
    // jamás entran al cupo de notificación.
    const urgent: Row[] = Array.from({ length: 50 }, (_, i) => ({
      _id: `p_urgent_${i}`,
      _creationTime: 1_000 + i,
      userId: `u_urgent_${i}`,
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
      kycExpiresAt: NOW + DAY_MS + i * 1_000,
    }))

    return { profiles: [...stale, ...urgent], notifications: [] }
  }

  it('los 50 perfiles a punto de vencer reciben aviso aunque su cuenta sea más nueva que los 100 "viejos"', async () => {
    const ctx = createConvexCtx(starvationTables())
    const result = await runHandler<Record<string, never>, { expiringSoon: number }>(
      checkKYCExpiration,
      ctx,
      {}
    )

    const notifiedIds = new Set(
      ctx.inserted
        .filter(
          (entry) => entry.table === 'notifications' && entry.row.title === 'KYC Próximo a Expirar'
        )
        .map((entry) => entry.row.userId as string)
    )

    for (let i = 0; i < 50; i++) {
      expect(notifiedIds.has(`p_urgent_${i}`)).toBe(true)
    }
    // Cupo de escritura por corrida sin cambios (paridad con el .take(100) anterior).
    expect(result.expiringSoon).toBeLessThanOrEqual(100)
  })

  it('declara honestamente si el universo VERIFIED-en-ventana excede el techo de escaneo', async () => {
    // Corrida chica para descubrir el cap real desde el argumento de
    // take(cap + 1), en vez de hardcodearlo.
    const probeCtx = createConvexCtx({
      profiles: [
        {
          _id: 'p_probe',
          _creationTime: 1,
          userId: 'u_probe',
          role: 'COMPANY',
          kycStatus: 'VERIFIED',
          kycExpiresAt: NOW + 5 * DAY_MS,
        },
      ],
      notifications: [],
    })
    await runHandler(checkKYCExpiration, probeCtx, {})
    // La segunda query sobre 'profiles' en esta mutation es expiringKYC (la
    // primera es expiredKYC, arriba en el archivo).
    const expiringBuilder = queryCallsFor(probeCtx, 'profiles')[1]
    const probeSize = expiringBuilder.take.mock.calls[0][0] as number
    const cap = probeSize - 1
    expect(cap).toBeGreaterThan(100)

    const belowCap: Row[] = Array.from({ length: 150 }, (_, i) => ({
      _id: `p_${i}`,
      _creationTime: i,
      userId: `u_${i}`,
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
      kycExpiresAt: NOW + 10 * DAY_MS,
    }))
    const belowCapCtx = createConvexCtx({ profiles: belowCap, notifications: [] })
    const belowCapResult = await runHandler<
      Record<string, never>,
      { expiringSoonScanTruncated: boolean }
    >(checkKYCExpiration, belowCapCtx, {})
    expect(belowCapResult.expiringSoonScanTruncated).toBe(false)

    const overCap: Row[] = Array.from({ length: cap + 25 }, (_, i) => ({
      _id: `p_${i}`,
      _creationTime: i,
      userId: `u_${i}`,
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
      kycExpiresAt: NOW + 10 * DAY_MS,
    }))
    const overCapCtx = createConvexCtx({ profiles: overCap, notifications: [] })
    const overCapResult = await runHandler<
      Record<string, never>,
      { expiringSoonScanTruncated: boolean; expiringSoon: number }
    >(checkKYCExpiration, overCapCtx, {})
    expect(overCapResult.expiringSoonScanTruncated).toBe(true)
    expect(overCapResult.expiringSoon).toBeLessThanOrEqual(100)
  })
})

// ============================================================================
// Hallazgo colateral del barrido 2026-07-30: el lookup de deduplicación de
// notificaciones (¿ya avisamos a este perfil en los últimos 7 días?) hacía
// `.filter(userId && type === 'system').first()` SIN índice: Convex evalúa el
// predicado fila por fila sobre TODA la tabla `notifications` — y en el peor
// caso (perfil sin aviso reciente) la recorre completa, hasta 100 veces por
// corrida. `notifications` ya tiene `by_userId_type`, que calza exacto con
// los dos campos del predicado: se usa para saltar directo a las
// notificaciones system de ESE perfil y el filtro por `_creationTime` corre
// solo sobre ese subconjunto.
// ============================================================================

describe('cronHandlers.checkKYCExpiration — dedup de avisos indexado por by_userId_type', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function expiringProfile(): Row {
    return {
      _id: 'p_expiring',
      _creationTime: 1,
      userId: 'u1',
      role: 'COMPANY',
      kycStatus: 'VERIFIED',
      kycExpiresAt: NOW + 5 * DAY_MS,
    }
  }

  it('el lookup de deduplicación usa el índice by_userId_type, no un filter sobre toda la tabla', async () => {
    const ctx = createConvexCtx({ profiles: [expiringProfile()], notifications: [] })
    await runHandler(checkKYCExpiration, ctx, {})

    const notificationBuilders = queryCallsFor(ctx, 'notifications')
    expect(notificationBuilders.length).toBeGreaterThan(0)
    for (const builder of notificationBuilders) {
      expect(builder.withIndex.mock.calls.length).toBeGreaterThan(0)
      expect(builder.withIndex.mock.calls[0][0]).toBe('by_userId_type')
    }
  })

  it('con un aviso system reciente NO duplica; con uno viejo sí vuelve a avisar', async () => {
    const recentCtx = createConvexCtx({
      profiles: [expiringProfile()],
      notifications: [
        {
          _id: 'n_recent',
          _creationTime: NOW - DAY_MS,
          userId: 'p_expiring',
          type: 'system',
          title: 'KYC Próximo a Expirar',
          isRead: false,
        },
      ],
    })
    await runHandler(checkKYCExpiration, recentCtx, {})
    expect(
      recentCtx.inserted.filter(
        (entry) => entry.table === 'notifications' && entry.row.title === 'KYC Próximo a Expirar'
      ).length
    ).toBe(0)

    const staleCtx = createConvexCtx({
      profiles: [expiringProfile()],
      notifications: [
        {
          _id: 'n_stale',
          _creationTime: NOW - 8 * DAY_MS,
          userId: 'p_expiring',
          type: 'system',
          title: 'KYC Próximo a Expirar',
          isRead: true,
        },
      ],
    })
    await runHandler(checkKYCExpiration, staleCtx, {})
    expect(
      staleCtx.inserted.filter(
        (entry) => entry.table === 'notifications' && entry.row.title === 'KYC Próximo a Expirar'
      ).length
    ).toBe(1)
  })
})
