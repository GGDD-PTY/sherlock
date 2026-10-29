// ============================================================================
// Actividad del data room — la agregación es pura y no puede duplicar descargas
// ============================================================================
// Una sola descarga deja DOS filas en `documentAccessLogs`:
// `getDownloadUrl` escribe DOWNLOAD_GRANT_ISSUED y `consumeDownloadGrant`
// escribe DOWNLOAD. Contar las dos duplicaría cada descarga en la pantalla del
// emisor sin que nada falle: es el defecto que se vería correcto al enviarse.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  buildRoomActivity,
  counterpartyCode,
  normalizeAccessAction,
  type ResolvedCounterparty,
} from '../../../convex/_documents/activity'

type Log = Parameters<typeof buildRoomActivity>[0]['logs'][number]

const NOW = 1_800_000_000_000

function log(overrides: Partial<Log> & { action: string }): Log {
  return {
    _id: `log_${Math.random().toString(36).slice(2)}`,
    _creationTime: NOW,
    documentId: 'document_1',
    accessedById: 'profile_investor',
    accessedAt: NOW,
    decision: 'ALLOW',
    ...overrides,
  } as Log
}

function build(
  logs: Log[],
  counterparties?: Map<string, ResolvedCounterparty>,
  roomScope = 'company_espave'
) {
  return buildRoomActivity({
    logs,
    documents: new Map([
      [
        'document_1' as never,
        { _id: 'document_1', name: 'Estados financieros', folder: 'financials' } as never,
      ],
    ]),
    counterparties: (counterparties ?? new Map()) as never,
    roomScope,
    windowDays: 30,
    scanCap: 500,
    scannedCount: logs.length,
  })
}

describe('normalizeAccessAction', () => {
  it('clasifica cada cadena que los escritores emiten hoy', () => {
    expect(normalizeAccessAction({ action: 'VIEW', decision: 'ALLOW' })).toBe('VIEW')
    expect(normalizeAccessAction({ action: 'DOWNLOAD', decision: 'ALLOW' })).toBe('DOWNLOAD')
    expect(normalizeAccessAction({ action: 'DOWNLOAD_GRANT_ISSUED', decision: 'ALLOW' })).toBe(
      'LINK'
    )
    expect(normalizeAccessAction({ action: 'VIEW_GRANT_ISSUED', decision: 'ALLOW' })).toBe('LINK')
    expect(normalizeAccessAction({ action: 'DOWNLOAD_DENIED', decision: 'DENY' })).toBe('BLOCKED')
    expect(normalizeAccessAction({ action: 'VIEW_DENIED', decision: 'DENY' })).toBe('BLOCKED')
  })

  it('la decisión gana sobre el prefijo de la acción', () => {
    expect(normalizeAccessAction({ action: 'DOWNLOAD', decision: 'REQUIRE_STEP_UP' })).toBe(
      'BLOCKED'
    )
  })

  it('una acción desconocida no se cuela como vista ni como descarga', () => {
    expect(normalizeAccessAction({ action: 'SHARE', decision: 'ALLOW' })).toBe('OTHER')
    expect(normalizeAccessAction({})).toBe('OTHER')
  })
})

describe('buildRoomActivity', () => {
  it('una descarga deja dos filas pero cuenta como exactamente una descarga', () => {
    const activity = build([log({ action: 'DOWNLOAD_GRANT_ISSUED' }), log({ action: 'DOWNLOAD' })])

    expect(activity.totals.downloads).toBe(1)
    expect(activity.totals.links).toBe(1)
    expect(activity.totals.views).toBe(0)
    expect(activity.byDocument[0].counters.downloads).toBe(1)
    // El cajón de eventos sigue siendo forense: las dos filas están ahí.
    expect(activity.events).toHaveLength(2)
  })

  it('un grant de VISTA tampoco infla el contador de vistas', () => {
    const activity = build([log({ action: 'VIEW_GRANT_ISSUED' }), log({ action: 'VIEW' })])

    expect(activity.totals.views).toBe(1)
    expect(activity.totals.links).toBe(1)
  })

  it('enmascara la identidad hasta que la conexión queda aceptada, con un código estable', () => {
    const hidden = new Map<string, ResolvedCounterparty>([
      [
        'profile_investor',
        { kind: 'UNKNOWN', displayName: 'Fondo Espavé', identityRevealed: false },
      ],
    ])

    const activity = build([log({ action: 'VIEW' }), log({ action: 'DOWNLOAD' })], hidden)

    expect(activity.byCounterparty).toHaveLength(1)
    expect(activity.byCounterparty[0].displayName).toBeNull()
    expect(activity.byCounterparty[0].identityRevealed).toBe(false)
    expect(activity.byCounterparty[0].code).toBe(counterpartyCode(activity.byCounterparty[0].key))
  })

  it('revela el nombre cuando la conexión está aceptada', () => {
    const revealed = new Map<string, ResolvedCounterparty>([
      [
        'profile_investor',
        { kind: 'TEAM', displayName: 'Fondo Espavé', identityRevealed: true },
      ],
    ])

    const activity = build([log({ action: 'VIEW' })], revealed)

    expect(activity.byCounterparty[0].displayName).toBe('Fondo Espavé')
  })

  it('cuenta contrapartes y documentos distintos, no filas', () => {
    const activity = build([
      log({ action: 'VIEW' }),
      log({ action: 'VIEW' }),
      log({ action: 'DOWNLOAD', accessedById: 'profile_other' as never }),
    ])

    expect(activity.counterpartyCount).toBe(2)
    expect(activity.documentCount).toBe(1)
    expect(activity.byDocument[0].counterpartyCount).toBe(2)
  })

  it('marca la corrida como truncada cuando se alcanza el techo de lectura', () => {
    const truncated = buildRoomActivity({
      logs: [],
      documents: new Map(),
      counterparties: new Map(),
      roomScope: 'company_espave',
      windowDays: 30,
      scanCap: 500,
      scannedCount: 500,
    })

    expect(truncated.truncated).toBe(true)
    expect(build([log({ action: 'VIEW' })]).truncated).toBe(false)
  })
})

// ============================================================================
// La contraparte anónima no puede venir con su id de perfil colgando
// ============================================================================
// Un `Id<'profiles'>` es estable entre deals, salas y pantallas. Si la clave que
// agrupa las filas ES ese id, basta con que la identidad se revele UNA vez en
// cualquier otra superficie para desanonimizar hacia atrás toda la actividad que
// el emisor guardó como "Inversionista A3F2".
// ============================================================================
describe('clave de contraparte proyectada al emisor', () => {
  const hidden = new Map<string, ResolvedCounterparty>([
    [
      'profile_investor',
      { kind: 'UNKNOWN', displayName: 'Fondo Espavé', identityRevealed: false },
    ],
  ])

  it('no es el id del perfil ni lo contiene en ninguna parte del payload', () => {
    const activity = build([log({ action: 'VIEW' }), log({ action: 'DOWNLOAD' })], hidden)

    expect(activity.byCounterparty[0].key).not.toBe('profile_investor')
    expect(JSON.stringify(activity)).not.toContain('profile_investor')
  })

  it('tampoco se cuela por el código corto que se pinta en pantalla', () => {
    const activity = build([log({ action: 'VIEW' })], hidden)

    expect(counterpartyCode('profile_investor')).not.toBe(activity.byCounterparty[0].code)
  })

  it('agrupa: el evento y su fila comparten la misma clave opaca', () => {
    const activity = build([log({ action: 'VIEW' }), log({ action: 'DOWNLOAD' })], hidden)

    expect(activity.byCounterparty).toHaveLength(1)
    for (const event of activity.events) {
      expect(event.counterpartyKey).toBe(activity.byCounterparty[0].key)
    }
  })

  it('es estable dentro de la sala entre corridas', () => {
    const first = build([log({ action: 'VIEW' })], hidden)
    const second = build([log({ action: 'DOWNLOAD' })], hidden)

    expect(second.byCounterparty[0].key).toBe(first.byCounterparty[0].key)
  })

  it('el mismo perfil en otra sala recibe otra clave: no se correlaciona', () => {
    const here = build([log({ action: 'VIEW' })], hidden, 'company_espave')
    const there = build([log({ action: 'VIEW' })], hidden, 'company_otra')

    expect(there.byCounterparty[0].key).not.toBe(here.byCounterparty[0].key)
  })

  it('dos perfiles distintos de la misma sala no colapsan en una sola fila', () => {
    const activity = build([
      log({ action: 'VIEW' }),
      log({ action: 'DOWNLOAD', accessedById: 'profile_other' as never }),
    ])

    const keys = new Set(activity.byCounterparty.map((row) => row.key))
    expect(keys.size).toBe(2)
    expect(new Set(activity.events.map((event) => event.counterpartyKey)).size).toBe(2)
  })
})
