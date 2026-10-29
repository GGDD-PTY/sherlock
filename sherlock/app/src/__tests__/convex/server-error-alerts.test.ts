// ============================================================================
// SERVER ERROR ALERTS — la ventana de 15 minutos (A7)
// ============================================================================
// Contratos: (1) el primer 5xx de una (ruta, error) manda campanita a todo
// ADMIN y un correo; (2) las repeticiones dentro de la ventana suben el conteo
// y PARCHAN esa campanita, sin segundo correo; (3) la ventana siguiente hereda
// las repeticiones silenciadas y las dice en su correo; (4) dos rutas o dos
// errores distintos son dos incidentes; (5) el probe sintético deja fila en
// `activityLogs`, que es la auditoría de una acción de operador.
//
// El reloj va con `vi.useFakeTimers({ toFake: ['Date'] })`: los handlers de
// Convex leen `Date.now()` y un seed con offsets relativos cruzaría a rojo a
// medianoche UTC.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

interface ServerErrorEmailCall {
  recipientProfileId: string
  link: string
  route: string
  errorName: string
  status: number
  message: string
  requestId: string
  method?: string
  synthetic: boolean
  occurrences: number
  suppressedRepeats: number
}

const sendServerErrorAlertEmail = vi.fn(
  async (_ctx: unknown, _args: ServerErrorEmailCall): Promise<void> => undefined
)
vi.mock('../../../convex/email', () => ({
  sendServerErrorAlertEmail: (ctx: unknown, args: ServerErrorEmailCall) =>
    sendServerErrorAlertEmail(ctx, args),
}))

import { SERVER_ERROR_ALERT_WINDOW_MS } from '../../../convex/_notifications/serverErrorAlertRedaction'
import {
  OBSERVABILITY_PROBE_ACTION,
  SERVER_ERROR_ALERT_ENTITY,
  SERVER_ERROR_ALERT_LINK,
  SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS,
  SERVER_ERROR_ALERT_TWIN_WINDOW_MS,
  recordServerError,
} from '../../../convex/_notifications/serverErrorAlerts'

const NOW = Date.UTC(2026, 8, 3, 12, 0, 0)

type Row = Record<string, unknown> & { _id: string; _creationTime: number }
type Tables = Record<string, Row[]>

function createCtx(seed: Tables = {}) {
  const tables: Tables = structuredClone(seed)
  const patches: Array<{ id: string; updates: Record<string, unknown> }> = []
  let sequence = 0

  const db = {
    async get(id: string) {
      return (
        Object.values(tables)
          .flat()
          .find((row) => row._id === id) ?? null
      )
    },
    async insert(table: string, value: Record<string, unknown>) {
      tables[table] ??= []
      sequence += 1
      const _id = `${table}_${sequence}`
      tables[table].push({ ...value, _id, _creationTime: Date.now() + sequence })
      return _id
    },
    async patch(id: string, updates: Record<string, unknown>) {
      const row = Object.values(tables)
        .flat()
        .find((candidate) => candidate._id === id)
      if (!row) throw new Error(`patch sobre fila inexistente: ${id}`)
      patches.push({ id, updates })
      Object.assign(row, updates)
    },
    query(table: string) {
      tables[table] ??= []
      let predicates: Array<(row: Row) => boolean> = []
      let descending = false
      const builder = {
        withIndex(
          _name: string,
          callback?: (q: {
            eq(field: string, value: unknown): unknown
            gt(field: string, value: number): unknown
          }) => unknown
        ) {
          const range = {
            eq(field: string, value: unknown) {
              predicates.push((row) => row[field] === value)
              return range
            },
            gt(field: string, value: number) {
              predicates.push((row) => Number(row[field]) > value)
              return range
            },
          }
          callback?.(range)
          return builder
        },
        order(direction: 'asc' | 'desc') {
          descending = direction === 'desc'
          return builder
        },
        rows() {
          const matched = tables[table].filter((row) => predicates.every((check) => check(row)))
          return descending ? [...matched].reverse() : matched
        },
        async first() {
          return builder.rows()[0] ?? null
        },
        async take(limit: number) {
          return builder.rows().slice(0, limit)
        },
        async collect() {
          return builder.rows()
        },
      }
      predicates = []
      return builder
    },
  }

  return { tables, patches, ctx: { db } }
}

/** Escrituras que tocaron una campanita: inserts + patches de `notifications`. */
function bellWrites(harness: ReturnType<typeof createCtx>): number {
  const ids = new Set(harness.tables.notifications.map((row) => row._id))
  return (
    harness.tables.notifications.length +
    harness.patches.filter((patch) => ids.has(patch.id)).length
  )
}

function seedWithTwoAdmins(): Tables {
  return {
    profiles: [
      { _id: 'profile_admin_1', _creationTime: 1, userId: 'user_1', role: 'ADMIN', isActive: true },
      { _id: 'profile_admin_2', _creationTime: 2, userId: 'user_2', role: 'ADMIN', isActive: true },
      { _id: 'profile_owner', _creationTime: 3, userId: 'user_3', role: 'COMPANY', isActive: true },
    ],
    users: [
      { _id: 'user_1', _creationTime: 1, email: 'fixture-4622a879@example.com' },
      { _id: 'user_2', _creationTime: 2, email: 'fixture-cffeaf6c@example.com' },
      { _id: 'user_3', _creationTime: 3, email: 'fixture-784a9103@example.com' },
    ],
    notifications: [],
    activityLogs: [],
    serverErrorAlerts: [],
  }
}

const BASE = {
  route: '/[locale]/vdr/[dealId]',
  errorName: 'TypeError',
  status: 500,
  message: 'no se pudo leer el documento',
  requestId: 'request-1',
  method: 'GET',
}

describe('serverErrorAlerts — ventana de correo', () => {
  beforeEach(() => {
    sendServerErrorAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('el primer 5xx despierta a todo ADMIN con campanita y correo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)

    expect(harness.tables.notifications).toHaveLength(2)
    for (const notification of harness.tables.notifications) {
      expect(notification.link).toBe(SERVER_ERROR_ALERT_LINK)
      expect(notification.entityType).toBe(SERVER_ERROR_ALERT_ENTITY)
      expect(notification.title).toBe('Error 500 en /[locale]/vdr/[dealId]')
      expect(notification.message).toContain('TypeError')
      expect(notification.message).toContain('request-1')
      expect(notification.isRead).toBe(false)
    }

    const alerts = harness.tables.serverErrorAlerts
    expect(alerts).toHaveLength(1)
    expect(alerts[0].dedupeKey).toBe('/[locale]/vdr/[dealId]|TypeError')
    expect(alerts[0].occurrences).toBe(1)
    expect(alerts[0].suppressedRepeats).toBe(0)
    expect(alerts[0].emailedAt).toBe(NOW)

    expect(sendServerErrorAlertEmail).toHaveBeenCalledTimes(2)
    expect(sendServerErrorAlertEmail.mock.calls[0]?.[1]).toMatchObject({
      route: BASE.route,
      errorName: 'TypeError',
      occurrences: 1,
      suppressedRepeats: 0,
      synthetic: false,
    })
  })

  it('una repetición dentro de la ventana cuenta, pero no manda correo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)
    sendServerErrorAlertEmail.mockClear()

    vi.setSystemTime(NOW + SERVER_ERROR_ALERT_WINDOW_MS - 1_000)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'request-2' })

    expect(sendServerErrorAlertEmail).not.toHaveBeenCalled()
    expect(harness.tables.serverErrorAlerts).toHaveLength(1)
    expect(harness.tables.serverErrorAlerts[0].occurrences).toBe(2)
    expect(harness.tables.serverErrorAlerts[0].requestId).toBe('request-2')
    expect(harness.tables.notifications).toHaveLength(2)
  })

  // EL CAMINO CALIENTE ES BARATO. Un 5xx público y repetido (un cuerpo
  // malformado que revienta un handler) llega miles de veces por minuto:
  // reescribir las campanitas de cada admin en cada repetición convierte la
  // tormenta de errores en una tormenta de escrituras a Convex.
  it('N repeticiones dentro de la ventana escriben exactamente una campanita por admin', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)
    const bellsAfterOpen = bellWrites(harness)
    const alertId = harness.tables.serverErrorAlerts[0]._id
    const rowPatchesAfterOpen = harness.patches.filter((patch) => patch.id === alertId).length

    for (let index = 0; index < 50; index += 1) {
      vi.setSystemTime(NOW + 1_000 * (index + 1))
      await recordServerError(harness.ctx as never, { ...BASE, requestId: `request-${index}` })
    }

    // Dos admins, una escritura de campanita cada uno: la apertura y nada más.
    expect(bellsAfterOpen).toBe(2)
    expect(bellWrites(harness)).toBe(2)
    expect(harness.tables.notifications).toHaveLength(2)

    // Y exactamente UNA escritura de fila por repetición, ni una más.
    const rowPatches = harness.patches.filter((patch) => patch.id === alertId).length
    expect(rowPatches - rowPatchesAfterOpen).toBe(50)
    expect(harness.tables.serverErrorAlerts[0].occurrences).toBe(51)
    expect(sendServerErrorAlertEmail).toHaveBeenCalledTimes(2)
  })

  // El lado app corta la ventana antes del round trip y manda lo acumulado en
  // `repeats`: el conteo de la fila tiene que seguir siendo el total de 5xx,
  // no el de mutaciones.
  it('suma las repeticiones que el proceso silenció antes de escribir', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, { ...BASE, repeats: 5 })
    expect(harness.tables.serverErrorAlerts[0].occurrences).toBe(5)
    expect(sendServerErrorAlertEmail.mock.calls[0]?.[1].occurrences).toBe(5)

    vi.setSystemTime(NOW + 60_000)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'r-2', repeats: 3 })

    expect(harness.tables.serverErrorAlerts).toHaveLength(1)
    expect(harness.tables.serverErrorAlerts[0].occurrences).toBe(8)
  })

  it('pasada la ventana abre incidente nuevo y hereda las repeticiones silenciadas', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)
    vi.setSystemTime(NOW + 60_000)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'request-2' })
    vi.setSystemTime(NOW + 120_000)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'request-3' })
    sendServerErrorAlertEmail.mockClear()

    vi.setSystemTime(NOW + SERVER_ERROR_ALERT_WINDOW_MS + 1)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'request-4' })

    expect(harness.tables.serverErrorAlerts).toHaveLength(2)
    const latest = harness.tables.serverErrorAlerts[1]
    expect(latest.occurrences).toBe(1)
    expect(latest.suppressedRepeats).toBe(2)

    expect(sendServerErrorAlertEmail).toHaveBeenCalledTimes(2)
    expect(sendServerErrorAlertEmail.mock.calls[0]?.[1]).toMatchObject({
      suppressedRepeats: 2,
      requestId: 'request-4',
    })
    expect(harness.tables.notifications).toHaveLength(4)
  })

  // El tick exacto: la ventana es [openedAt, openedAt+15m). A los 15 minutos
  // clavados ya es incidente nuevo, y eso vale un test porque el `>` de la
  // comparación es lo único que lo dice.
  it('a los 15 minutos clavados abre incidente nuevo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)
    sendServerErrorAlertEmail.mockClear()

    vi.setSystemTime(NOW + SERVER_ERROR_ALERT_WINDOW_MS - 1)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'r-borde' })
    expect(harness.tables.serverErrorAlerts).toHaveLength(1)

    vi.setSystemTime(NOW + SERVER_ERROR_ALERT_WINDOW_MS)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'r-nueva' })
    expect(harness.tables.serverErrorAlerts).toHaveLength(2)
  })

  // `suppressedRepeats` dice "esto se silenció desde el aviso anterior". Si la
  // ventana previa es de hace horas, el correo estaría mintiendo: esas
  // repeticiones no se silenciaron ahora, ya tuvieron su propio aviso.
  it('no arrastra las repeticiones de una ventana vieja', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)
    vi.setSystemTime(NOW + 60_000)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'r-2' })
    vi.setSystemTime(NOW + 120_000)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'r-3' })
    sendServerErrorAlertEmail.mockClear()

    vi.setSystemTime(NOW + 3 * 60 * 60 * 1000)
    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'r-mucho-despues' })

    const ultima = harness.tables.serverErrorAlerts[1]
    expect(ultima.suppressedRepeats).toBe(0)
    expect(sendServerErrorAlertEmail.mock.calls[0]?.[1].suppressedRepeats).toBe(0)
  })

  // Una ventana silenciada por el techo global no tuvo aviso propio, asi que
  // arrastra TODAS sus ocurrencias, no todas menos una.
  it('arrastra entero el conteo de una ventana que nunca avisó', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    for (let index = 0; index < SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS; index += 1) {
      await recordServerError(harness.ctx as never, { ...BASE, route: `/api/ruta-${index}` })
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await recordServerError(harness.ctx as never, { ...BASE, route: '/api/silenciada' })
    vi.setSystemTime(NOW + 60_000)
    await recordServerError(harness.ctx as never, { ...BASE, route: '/api/silenciada' })
    warn.mockRestore()
    sendServerErrorAlertEmail.mockClear()

    vi.setSystemTime(NOW + SERVER_ERROR_ALERT_WINDOW_MS + 60_000)
    await recordServerError(harness.ctx as never, { ...BASE, route: '/api/silenciada' })

    expect(sendServerErrorAlertEmail.mock.calls[0]?.[1].suppressedRepeats).toBe(2)
  })

  it('otra ruta u otro error son otro incidente, con su propio correo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)
    await recordServerError(harness.ctx as never, { ...BASE, route: '/api/vdr/export' })
    await recordServerError(harness.ctx as never, { ...BASE, errorName: 'ConvexError' })

    expect(harness.tables.serverErrorAlerts).toHaveLength(3)
    expect(sendServerErrorAlertEmail).toHaveBeenCalledTimes(6)
  })

  // EL DEBOUNCE ES POR LLAVE; ESTO ES EL TECHO GLOBAL. Una caída de Convex
  // revienta N handlers con 2 o 3 nombres de error distintos: cada combinación
  // es su propia ventana, y sin tope son decenas de correos y campanitas en un
  // minuto para los mismos dos ADMIN. Pasado el techo la fila se escribe igual
  // — es el registro de que producción se rompió — pero nadie recibe nada.
  it('deja de despertar al equipo pasado el techo de ventanas nuevas', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    for (let index = 0; index < SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS; index += 1) {
      await recordServerError(harness.ctx as never, { ...BASE, route: `/api/ruta-${index}` })
    }
    expect(sendServerErrorAlertEmail).toHaveBeenCalledTimes(SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS * 2)
    sendServerErrorAlertEmail.mockClear()
    const bellsAntes = harness.tables.notifications.length

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await recordServerError(harness.ctx as never, { ...BASE, route: '/api/una-mas' })
    warn.mockRestore()

    expect(harness.tables.serverErrorAlerts).toHaveLength(SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS + 1)
    const ultima = harness.tables.serverErrorAlerts[SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS]
    expect(ultima.emailedAt).toBeUndefined()
    expect(ultima.notificationIds).toEqual([])
    expect(harness.tables.notifications).toHaveLength(bellsAntes)
    expect(sendServerErrorAlertEmail).not.toHaveBeenCalled()
  })

  // El probe es como el operador comprueba que el canal sirve: si la tormenta
  // lo silencia, el operador concluye que la alerta está rota.
  it('el probe sintético atraviesa el techo global', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    for (let index = 0; index < SERVER_ERROR_ALERT_MAX_OPEN_WINDOWS + 2; index += 1) {
      await recordServerError(harness.ctx as never, { ...BASE, route: `/api/ruta-${index}` })
    }
    sendServerErrorAlertEmail.mockClear()

    await recordServerError(harness.ctx as never, {
      ...BASE,
      route: '/api/observability/probe',
      errorName: 'SyntheticObservabilityProbe',
      synthetic: true,
    })

    expect(sendServerErrorAlertEmail).toHaveBeenCalledTimes(2)
  })

  // GEMELAS. `by_dedupeKey` no es único: dos 5xx simultáneos pueden abrir dos
  // ventanas. Campanitas duplicadas se aceptan; el segundo correo, no. El
  // harness es serial, así que la primera lectura de hermanas se oculta para
  // reproducir la transacción que aún no ve la fila de la otra.
  it('la gemela concurrente no manda un segundo correo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, BASE)
    expect(sendServerErrorAlertEmail).toHaveBeenCalledTimes(2)
    sendServerErrorAlertEmail.mockClear()

    let concealExistingWindow = true
    const innerQuery = harness.ctx.db.query.bind(harness.ctx.db)
    harness.ctx.db.query = ((table: string) => {
      const builder = innerQuery(table)
      if (table !== 'serverErrorAlerts') return builder
      const innerTake = builder.take.bind(builder)
      builder.take = async (limit: number) => {
        if (concealExistingWindow) {
          concealExistingWindow = false
          return []
        }
        return innerTake(limit)
      }
      return builder
    }) as typeof harness.ctx.db.query

    await recordServerError(harness.ctx as never, { ...BASE, requestId: 'request-gemela' })

    expect(sendServerErrorAlertEmail).not.toHaveBeenCalled()
    expect(harness.tables.serverErrorAlerts).toHaveLength(2)
    expect(harness.tables.serverErrorAlerts[0]?.emailedAt).toBe(NOW)
    expect(harness.tables.serverErrorAlerts[1]?.emailedAt).toBeUndefined()
    expect(
      Math.abs(Number(harness.tables.serverErrorAlerts[0]?.openedAt) - NOW)
    ).toBeLessThanOrEqual(SERVER_ERROR_ALERT_TWIN_WINDOW_MS)
    // Campanitas duplicadas: un par por cada ventana gemela.
    expect(harness.tables.notifications).toHaveLength(4)
  })

  it('el probe sintético se audita en activityLogs y se nombra como tal', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, {
      route: '/api/observability/probe',
      errorName: 'SyntheticObservabilityProbe',
      status: 500,
      message: 'Probe sintetico de observabilidad: 5xx forzado',
      requestId: 'request-probe',
      method: 'POST',
      synthetic: true,
    })

    expect(harness.tables.activityLogs).toHaveLength(1)
    expect(harness.tables.activityLogs[0]).toMatchObject({
      action: OBSERVABILITY_PROBE_ACTION,
      entityId: 'request-probe',
    })
    // Acción de operador: no hay perfil admin al que atribuirla.
    expect(harness.tables.activityLogs[0].userId).toBeUndefined()

    expect(harness.tables.notifications[0].title).toBe(
      'Probe sintético en /api/observability/probe'
    )
    expect(sendServerErrorAlertEmail.mock.calls[0]?.[1].synthetic).toBe(true)
  })

  it('un 5xx sin ADMIN vivos deja la fila igual, sin campanita ni correo', async () => {
    const harness = createCtx({
      profiles: [
        {
          _id: 'profile_admin_1',
          _creationTime: 1,
          userId: 'user_1',
          role: 'ADMIN',
          isActive: false,
        },
      ],
      users: [{ _id: 'user_1', _creationTime: 1, email: 'fixture-c3a52090@example.com' }],
      notifications: [],
      activityLogs: [],
      serverErrorAlerts: [],
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await recordServerError(harness.ctx as never, BASE)

    expect(harness.tables.serverErrorAlerts).toHaveLength(1)
    expect(harness.tables.notifications).toHaveLength(0)
    expect(sendServerErrorAlertEmail).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // Segundo cinturón: aunque el lado app fallara en tachar, la fila y el correo
  // no pueden quedarse con la cédula ni con el teléfono del dueño de la sala.
  it('no persiste ni manda cédula, teléfono ni correo aunque lleguen en el mensaje', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, {
      ...BASE,
      message:
        'no hay sala para Ana Robles, cédula 8-123-456, tel 6123-4567, fixture-d95e361d@example.com',
      digest: 'a3f9c1d2',
    })

    const persisted = JSON.stringify(harness.tables)
    const enviado = JSON.stringify(sendServerErrorAlertEmail.mock.calls)
    for (const dato of ['8-123-456', '6123-4567', 'fixture-d95e361d@example.com']) {
      expect(persisted).not.toContain(dato)
      expect(enviado).not.toContain(dato)
    }
    expect(harness.tables.serverErrorAlerts[0].digest).toBe('a3f9c1d2')
  })

  it('corta el mensaje en 120 caracteres aunque llegue más largo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, { ...BASE, message: 'y'.repeat(400) })

    expect(String(harness.tables.serverErrorAlerts[0].message).length).toBeLessThanOrEqual(120)
  })

  it('acota lo que persiste aunque el payload llegue largo o sucio', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordServerError(harness.ctx as never, {
      route: `/api/${'x'.repeat(500)}`,
      errorName: `${'N'.repeat(200)}`,
      status: 500,
      message: 'y'.repeat(900),
      requestId: 'r'.repeat(400),
      method: 'post',
      synthetic: false,
    })

    const alert = harness.tables.serverErrorAlerts[0]
    expect(String(alert.route).length).toBeLessThanOrEqual(200)
    expect(String(alert.errorName).length).toBeLessThanOrEqual(64)
    expect(String(alert.message).length).toBeLessThanOrEqual(200)
    expect(String(alert.requestId).length).toBeLessThanOrEqual(128)
    expect(alert.method).toBe('POST')
  })
})
