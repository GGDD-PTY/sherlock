// ============================================================================
// TEAM ALERTS — el equipo se entera de que el cliente se movió
// ============================================================================
// Contratos: (1) toda subida de un cliente le llega a TODOS los perfiles ADMIN;
// (2) la unidad es la TANDA, no el archivo: un segundo finalize dentro de la
// misma ventana parcha la misma campanita en vez de insertar otra, y el correo
// sale exactamente una vez por tanda aunque el finalize se reintente;
// (3) un fallo del aviso jamás tumba la mutación de producto que lo dispara.
// ============================================================================

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '../../../convex/_generated/dataModel'

interface TeamAlertEmailCall {
  recipientProfileId: string
  kind: string
  companyName: string
  fileCount: number
  folders: string[]
  fileNames: string[]
  link: string
}

const sendTeamAlertEmail = vi.fn(
  async (_ctx: unknown, _args: TeamAlertEmailCall): Promise<void> => undefined
)
vi.mock('../../../convex/email', () => ({
  sendTeamAlertEmail: (ctx: unknown, args: TeamAlertEmailCall) => sendTeamAlertEmail(ctx, args),
}))

import {
  TEAM_ALERT_BATCH_WINDOW_MS,
  TEAM_ALERT_EMAIL_DEBOUNCE_MS,
  attachCompanyToIntakeAlert,
  dispatchTeamAlertEmail,
  recordCompanyWorkspaceCreated,
  recordIntakeUpload,
  recordVdrUpload,
} from '../../../convex/_notifications/teamAlerts'

const NOW = Date.UTC(2026, 8, 1, 15, 0, 0)

type Row = Record<string, unknown> & { _id: string; _creationTime: number }
type Tables = Record<string, Row[]>

function createCtx(seed: Tables = {}) {
  const tables: Tables = structuredClone(seed)
  let sequence = 0
  const scheduled: Array<{ id: string; delayMs: number; args: unknown }> = []
  const cancelled: string[] = []

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
      tables[table].push({ ...value, _id, _creationTime: NOW + sequence })
      return _id
    },
    async patch(id: string, updates: Record<string, unknown>) {
      const row = Object.values(tables)
        .flat()
        .find((candidate) => candidate._id === id)
      if (!row) throw new Error(`patch sobre fila inexistente: ${id}`)
      Object.assign(row, updates)
    },
    query(table: string) {
      tables[table] ??= []
      let predicates: Array<(row: Row) => boolean> = []
      let descending = false
      const builder = {
        withIndex(
          _name: string,
          callback?: (q: { eq(field: string, value: unknown): unknown }) => unknown
        ) {
          const range = {
            eq(field: string, value: unknown) {
              predicates.push((row) => row[field] === value)
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

  return {
    tables,
    scheduled,
    cancelled,
    ctx: {
      db,
      scheduler: {
        async runAfter(delayMs: number, _reference: unknown, args: unknown) {
          sequence += 1
          const id = `job_${sequence}`
          scheduled.push({ id, delayMs, args })
          return id
        },
        async cancel(id: string) {
          cancelled.push(id)
        },
      },
    },
  }
}

function seedWithTwoAdmins(): Tables {
  return {
    profiles: [
      {
        _id: 'profile_admin_1',
        _creationTime: 1,
        userId: 'user_admin_1',
        role: 'ADMIN',
        isActive: true,
      },
      {
        _id: 'profile_admin_2',
        _creationTime: 2,
        userId: 'user_admin_2',
        role: 'ADMIN',
        isActive: true,
      },
      {
        _id: 'profile_owner',
        _creationTime: 3,
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    users: [
      { _id: 'user_admin_1', _creationTime: 1, email: 'fixture-67bb0a48@example.com' },
      { _id: 'user_admin_2', _creationTime: 2, email: 'fixture-b2ce6752@example.com' },
      { _id: 'user_owner', _creationTime: 3, email: 'fixture-784a9103@example.com' },
    ],
    companies: [
      { _id: 'company_1', _creationTime: 4, ownerId: 'profile_owner', name: 'Sample Hydro' },
    ],
    notifications: [],
    teamAlerts: [],
  }
}

const COMPANY_ID = 'company_1' as Id<'companies'>

describe('teamAlerts — subida en la sala del cliente', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('le avisa a todos los ADMIN, con empresa, conteo, carpeta y link a la sala', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })

    const notifications = harness.tables.notifications
    expect(notifications).toHaveLength(2)
    expect(new Set(notifications.map((row) => row.userId))).toEqual(
      new Set(['profile_admin_1', 'profile_admin_2'])
    )
    for (const notification of notifications) {
      expect(notification.link).toBe('/admin/companies/company_1/documents')
      expect(`${notification.title} ${notification.message}`).toContain('Sample Hydro')
      // La campanita dice la carpeta como la muestra la sala, nunca su llave.
      expect(notification.message).toContain('en 3. Financieros')
      expect(notification.message).not.toContain('room_')
      expect(notification.isRead).toBe(false)
    }

    const alerts = harness.tables.teamAlerts
    expect(alerts).toHaveLength(1)
    expect(alerts[0].fileCount).toBe(1)
    expect(alerts[0].batchKey).toBe('vdr:company_1')
  })

  it('un segundo finalize de la misma tanda no crea una segunda notificación', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })
    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'contratos.pdf',
      folder: 'room_legal',
    })

    expect(harness.tables.teamAlerts).toHaveLength(1)
    expect(harness.tables.notifications).toHaveLength(2)
    expect(harness.tables.teamAlerts[0].fileCount).toBe(2)
    for (const notification of harness.tables.notifications) {
      expect(notification.message).toContain('2')
      expect(notification.message).toContain('Legales')
    }
  })

  it('el correo sale una vez por tanda: un job repetido no vuelve a enviar', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })
    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'contratos.pdf',
      folder: 'room_legal',
    })

    const alertId = harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>
    await dispatchTeamAlertEmail(harness.ctx as never, { alertId })
    await dispatchTeamAlertEmail(harness.ctx as never, { alertId })

    // Un destinatario por ADMIN y nada más: contar llamadas sola no distingue
    // "un despacho por dos admins" de "dos despachos por un admin".
    const recipients = sendTeamAlertEmail.mock.calls.map(([, args]) => args.recipientProfileId)
    expect(recipients.sort()).toEqual(['profile_admin_1', 'profile_admin_2'])
    // Y el conteo del correo es el de la tanda cerrada, no el del primer archivo.
    expect(sendTeamAlertEmail.mock.calls[0][1].fileCount).toBe(2)
    expect(harness.tables.teamAlerts[0].emailDispatchedAt).toBe(NOW)
  })

  it('el correo va a quien recibió la campanita, no a un ADMIN que llegó después', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })
    harness.tables.profiles.push({
      _id: 'profile_admin_3',
      _creationTime: 9,
      userId: 'user_admin_3',
      role: 'ADMIN',
      isActive: true,
    })

    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>,
    })

    const recipients = sendTeamAlertEmail.mock.calls.map(([, args]) => args.recipientProfileId)
    expect(recipients.sort()).toEqual(['profile_admin_1', 'profile_admin_2'])
  })

  it('un ADMIN desactivado no recibe la campanita', async () => {
    const seed = seedWithTwoAdmins()
    seed.profiles[1].isActive = false
    const harness = createCtx(seed)

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })

    expect(harness.tables.notifications.map((row) => row.userId)).toEqual(['profile_admin_1'])
  })

  it('una campanita ya borrada no aborta el resto de la tanda', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })
    harness.tables.notifications.splice(0, 1)

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'segundo.pdf',
      folder: 'room_financial',
    })

    expect(harness.tables.teamAlerts[0].fileCount).toBe(2)
    expect(harness.tables.notifications).toHaveLength(1)
    expect(harness.tables.notifications[0].message).toContain('2')
  })

  it('pasada la ventana, la siguiente subida abre otra tanda y otra campanita', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })

    vi.setSystemTime(NOW + TEAM_ALERT_BATCH_WINDOW_MS + 1)
    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'segundo.pdf',
      folder: 'room_financial',
    })

    expect(harness.tables.teamAlerts).toHaveLength(2)
    expect(harness.tables.notifications).toHaveLength(4)
  })
})

describe('teamAlerts — intake anónimo y alta de espacio', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('la tanda del intake se agrupa por sesión y nombra la identidad declarada', async () => {
    const seed = seedWithTwoAdmins()
    seed.intakeSessions = [
      {
        _id: 'intake_1',
        _creationTime: 5,
        identityEvidence: { kind: 'NAME', name: 'Andina Logistics', capturedAt: NOW },
      },
    ]
    const harness = createCtx(seed)

    await recordIntakeUpload(harness.ctx as never, {
      intakeSessionId: 'intake_1' as Id<'intakeSessions'>,
      fileName: 'balance.xlsx',
    })
    await recordIntakeUpload(harness.ctx as never, {
      intakeSessionId: 'intake_1' as Id<'intakeSessions'>,
      fileName: 'ventas.csv',
    })

    expect(harness.tables.teamAlerts).toHaveLength(1)
    expect(harness.tables.teamAlerts[0].batchKey).toBe('intake:intake_1')
    expect(harness.tables.notifications).toHaveLength(2)
    for (const notification of harness.tables.notifications) {
      expect(`${notification.title} ${notification.message}`).toContain('Andina Logistics')
    }
  })

  it('el alta de un espacio avisa una sola vez, aunque la mutación se repita', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordCompanyWorkspaceCreated(harness.ctx as never, { companyId: COMPANY_ID })
    await recordCompanyWorkspaceCreated(harness.ctx as never, { companyId: COMPANY_ID })

    expect(harness.tables.teamAlerts).toHaveLength(1)
    expect(harness.tables.teamAlerts[0].kind).toBe('COMPANY_WORKSPACE_CREATED')
    expect(harness.tables.notifications).toHaveLength(2)
    for (const notification of harness.tables.notifications) {
      expect(`${notification.title} ${notification.message}`).toContain('Sample Hydro')
      expect(notification.link).toBe('/admin/companies/company_1/documents')
    }
  })
})

describe('teamAlerts — bordes', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('una empresa inexistente no escribe nada ni lanza', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await expect(
      recordVdrUpload(harness.ctx as never, {
        companyId: 'company_fantasma' as Id<'companies'>,
        fileName: 'x.pdf',
        folder: 'General',
      })
    ).resolves.toBeUndefined()
    expect(harness.tables.notifications).toHaveLength(0)
    expect(harness.tables.teamAlerts).toHaveLength(0)
  })

  it('un fallo a mitad de la tanda propaga, para que Convex revierta la fila', async () => {
    // Atrapar acá dejaría COMMITEADA una fila de `teamAlerts` sin campanitas y
    // sin job de correo, y `openBatch` la adoptaría durante los 10 minutos
    // siguientes: la tanda entera se perdería en silencio. El aviso corre en su
    // propia mutación calendarizada, así que dejar subir la excepción es lo que
    // la revierte entera. (El rollback lo hace Convex; este harness no lo
    // modela, así que lo único observable acá es que la excepción sube.)
    const harness = createCtx(seedWithTwoAdmins())
    const realInsert = harness.ctx.db.insert
    let inserts = 0
    harness.ctx.db.insert = (async (table: string, value: Record<string, unknown>) => {
      inserts += 1
      if (inserts === 2) throw new Error('convex write failed')
      return realInsert(table, value)
    }) as never

    await expect(
      recordCompanyWorkspaceCreated(harness.ctx as never, { companyId: COMPANY_ID })
    ).rejects.toThrow('convex write failed')
  })
})

describe('teamAlerts — el aviso nunca corre en la transacción del cliente', () => {
  // Contrato de código fuente, no de comportamiento. n subidas concurrentes de
  // una misma empresa escriben la MISMA fila de `teamAlerts`; Convex detecta ese
  // conflicto al hacer commit, fuera del handler, donde ningún try/catch llega.
  // Llamar al módulo en línea le cobraría al cliente su documento cuando el
  // aviso pierde la carrera, así que los tres disparadores CALENDARIZAN.
  const CASES = [
    ['convex/_documents/ingest.ts', '_recordVdrUpload'],
    ['convex/intake.ts', '_recordIntakeUpload'],
    ['convex/companies.ts', '_recordCompanyWorkspaceCreated'],
  ] as const

  it.each(CASES)('%s calendariza %s en vez de llamarlo en línea', (relativePath, fn) => {
    const source = readFileSync(resolve(process.cwd(), relativePath), 'utf8')

    expect(source).toContain(`internal.notifications.${fn}`)
    expect(source).toMatch(
      new RegExp(`scheduler\\.runAfter\\(\\s*0,\\s*internal\\.notifications\\.${fn}`)
    )
    expect(source).not.toContain("from './_notifications/teamAlerts'")
    expect(source).not.toContain("from '../_notifications/teamAlerts'")
  })

  // El claim usa `makeFunctionReference` en vez de `internal.*` (ciclo de
  // imports), pero la regla es la misma: calendariza, no llama en línea.
  it('convex/_intake/claim.ts calendariza el reapunte del aviso', () => {
    const source = readFileSync(resolve(process.cwd(), 'convex/_intake/claim.ts'), 'utf8')

    expect(source).toContain("'notifications:_attachCompanyToIntakeAlert'")
    expect(source).toMatch(/scheduler\.runAfter\(\s*0,\s*attachCompanyToIntakeAlertRef/)
    expect(source).not.toContain("from '../_notifications/teamAlerts'")
  })
})

// ============================================================================
// DESTINATARIOS: `isActive` NO ESTÁ EN TODAS LAS FILAS
// ============================================================================
// `isActive` es opcional y su default de producto es "activo". El índice
// `by_role_isActive` con `.eq('isActive', true)` NO alcanza las filas donde el
// campo falta: con cero destinatarios encontrados, `openNewBatch` salía en
// silencio y no había ni fila, ni campanita, ni correo. El aviso se pierde
// entero y nadie se entera de que se perdió.

describe('teamAlerts — destinatarios', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('un ADMIN sin el campo isActive sigue siendo destinatario', async () => {
    const seed = seedWithTwoAdmins()
    delete seed.profiles[0].isActive
    const harness = createCtx(seed)

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })

    expect(new Set(harness.tables.notifications.map((row) => row.userId))).toEqual(
      new Set(['profile_admin_1', 'profile_admin_2'])
    )
  })

  it('un ADMIN con isActive false sigue fuera', async () => {
    const seed = seedWithTwoAdmins()
    seed.profiles[1].isActive = false
    const harness = createCtx(seed)

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'x.pdf',
      folder: 'room_financial',
    })

    expect(harness.tables.notifications.map((row) => row.userId)).toEqual(['profile_admin_1'])
  })

  it('sin ningún ADMIN escribe la fila igual, avisa por consola y no manda correo', async () => {
    const seed = seedWithTwoAdmins()
    seed.profiles = seed.profiles.filter((row) => row.role !== 'ADMIN')
    const harness = createCtx(seed)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })

    // La fila existe: el alta posterior de un ADMIN puede verla, y la tanda
    // siguiente la adopta en vez de abrir otra.
    expect(harness.tables.teamAlerts).toHaveLength(1)
    expect(harness.tables.teamAlerts[0].fileCount).toBe(1)
    expect(harness.tables.notifications).toHaveLength(0)
    expect(warn).toHaveBeenCalled()

    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>,
    })
    expect(sendTeamAlertEmail).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ============================================================================
// AMPLIAR LA TANDA VUELVE A LEVANTAR LA MANO
// ============================================================================

describe('teamAlerts — la ampliación vuelve a marcar sin leer', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('un archivo nuevo en la tanda vuelve isRead a false', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })
    for (const notification of harness.tables.notifications) {
      notification.isRead = true
    }

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'segundo.pdf',
      folder: 'room_legal',
    })

    expect(harness.tables.notifications.map((row) => row.isRead)).toEqual([false, false])
  })
})

// ============================================================================
// EL DEBOUNCE DEL CORREO TIENE TECHO
// ============================================================================
// Sin techo, subidas cada 90 s reprograman el envío para siempre: la tanda
// queda abierta y el correo no sale nunca.

describe('teamAlerts — techo del debounce', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('pasada la media hora desde que abrió, el correo sale ya', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })

    // Goteo dentro de la ventana de tanda: cada subida reprograma el envío.
    for (let minute = 3; minute <= 33; minute += 3) {
      vi.setSystemTime(NOW + minute * 60_000)
      await recordVdrUpload(harness.ctx as never, {
        companyId: COMPANY_ID,
        fileName: `archivo-${minute}.pdf`,
        folder: 'room_financial',
      })
    }

    // Una sola tanda, y el último envío programado ya no espera el debounce.
    expect(harness.tables.teamAlerts).toHaveLength(1)
    expect(harness.scheduled.at(-1)?.delayMs).toBe(0)
  })

  it('dentro de la media hora el debounce sigue completo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })
    vi.setSystemTime(NOW + 3 * 60_000)
    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'segundo.pdf',
      folder: 'room_financial',
    })

    expect(harness.scheduled.at(-1)?.delayMs).toBe(TEAM_ALERT_EMAIL_DEBOUNCE_MS)
  })
})

// ============================================================================
// DOS TANDAS GEMELAS NO MANDAN DOS CORREOS
// ============================================================================
// El índice `by_batchKey` NO es único. Dos `finalize` concurrentes sin fila
// previa pueden insertar dos filas de la misma tanda; el despacho las reconoce
// como gemelas y solo la primera manda correo.

describe('teamAlerts — tandas gemelas', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('la gemela se cierra sin mandar un segundo correo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })
    // La segunda fila con el MISMO batchKey: lo que deja una carrera que el
    // índice no puede impedir.
    const twin = structuredClone(harness.tables.teamAlerts[0])
    twin._id = 'teamAlerts_gemela'
    twin._creationTime = NOW + 1
    harness.tables.teamAlerts.push(twin)

    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>,
    })
    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: 'teamAlerts_gemela' as Id<'teamAlerts'>,
    })

    const recipients = sendTeamAlertEmail.mock.calls.map(([, args]) => args.recipientProfileId)
    expect(recipients.sort()).toEqual(['profile_admin_1', 'profile_admin_2'])
    // Y la gemela queda cerrada, para que ningún reintento la despierte.
    expect(harness.tables.teamAlerts[1].emailDispatchedAt).toBe(NOW)
  })

  it('una tanda posterior del mismo batchKey sí manda su correo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })
    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>,
    })
    sendTeamAlertEmail.mockClear()

    vi.setSystemTime(NOW + TEAM_ALERT_BATCH_WINDOW_MS + 1)
    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'segundo.pdf',
      folder: 'room_financial',
    })
    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[1]._id as Id<'teamAlerts'>,
    })

    expect(sendTeamAlertEmail).toHaveBeenCalledTimes(2)
  })

  // La tanda que el dedupe se comía: la anterior YA despachó (por eso `openBatch`
  // no la reusa), así que la segunda es legítima aunque abra minutos después.
  // Medida contra la ventana de tanda, era indistinguible de una gemela.
  it('una tanda abierta dentro de los 10 min de la anterior sí manda su correo', async () => {
    const harness = createCtx(seedWithTwoAdmins())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'primero.pdf',
      folder: 'room_financial',
    })
    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>,
    })
    sendTeamAlertEmail.mockClear()

    // Tres minutos después: dentro de la ventana de tanda, pero la anterior ya
    // cerró, así que `openBatch` abre una fila nueva.
    vi.setSystemTime(NOW + 3 * 60 * 1000)
    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'segundo.pdf',
      folder: 'room_financial',
    })
    expect(harness.tables.teamAlerts).toHaveLength(2)

    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[1]._id as Id<'teamAlerts'>,
    })

    expect(sendTeamAlertEmail).toHaveBeenCalledTimes(2)
  })
})

// ============================================================================
// EL CLAIM LE PONE EMPRESA AL AVISO QUE NACIÓ ANÓNIMO
// ============================================================================
// La tanda de intake se abre antes de que exista la empresa: `companyId` vacío
// y link genérico a `/admin/companies`. Cuando el claim asigna la empresa, ese
// aviso tiene que apuntar a la sala real — si no, el equipo entra al listado y
// busca a mano cuál de todas fue.

describe('teamAlerts — el claim reapunta el aviso del intake', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  function seedWithIntakeAlert() {
    const seed = seedWithTwoAdmins()
    seed.intakeSessions = [
      {
        _id: 'intake_1',
        _creationTime: 5,
        identityEvidence: { kind: 'NAME', name: 'Andina Logistics', capturedAt: NOW },
      },
    ]
    return seed
  }

  it('parcha companyId, nombre y link del aviso abierto y lo vuelve no leído', async () => {
    const seed = seedWithIntakeAlert()
    // El claim aplica el nombre declarado y lo CONFIRMA (`_intake/claim.ts`):
    // solo entonces la fila de `companies` manda sobre el aviso.
    seed.companyChecklist = [
      { _id: 'checklist_1', _creationTime: 6, companyId: 'company_1', nameConfirmedAt: NOW },
    ]
    const harness = createCtx(seed)

    await recordIntakeUpload(harness.ctx as never, {
      intakeSessionId: 'intake_1' as Id<'intakeSessions'>,
      fileName: 'balance.xlsx',
    })
    expect(harness.tables.teamAlerts[0].link).toBe('/admin/companies')
    for (const notification of harness.tables.notifications) {
      notification.isRead = true
    }

    await attachCompanyToIntakeAlert(harness.ctx as never, {
      intakeSessionId: 'intake_1' as Id<'intakeSessions'>,
      companyId: COMPANY_ID,
    })

    expect(harness.tables.teamAlerts[0]).toMatchObject({
      companyId: 'company_1',
      companyName: 'Sample Hydro',
      link: '/admin/companies/company_1/documents',
    })
    for (const notification of harness.tables.notifications) {
      expect(notification.link).toBe('/admin/companies/company_1/documents')
      expect(`${notification.title} ${notification.message}`).toContain('Sample Hydro')
      expect(notification.isRead).toBe(false)
    }
  })

  it('el nombre declarado en el intake no lo rebaja el alta automática', async () => {
    // El primer login provisiona la empresa con el nombre del DUEÑO
    // (`companies.ensureCompanyWorkspace`), y el claim corre antes de que el
    // nombre real aterrice: sin confirmar, la fila no puede pisar lo que la
    // persona escribió en /mycroft. Dry run del 2026-09-04 (H7): el aviso decía
    // «Maintainer Gonzalez» en vez de «Grupo Calesa, S.A. y Subsidiarias».
    const seed = seedWithIntakeAlert()
    seed.companies[0].name = 'Maintainer Gonzalez'
    const harness = createCtx(seed)

    await recordIntakeUpload(harness.ctx as never, {
      intakeSessionId: 'intake_1' as Id<'intakeSessions'>,
      fileName: 'balance.xlsx',
    })
    await attachCompanyToIntakeAlert(harness.ctx as never, {
      intakeSessionId: 'intake_1' as Id<'intakeSessions'>,
      companyId: COMPANY_ID,
    })

    expect(harness.tables.teamAlerts[0]).toMatchObject({
      companyId: 'company_1',
      companyName: 'Andina Logistics',
      link: '/admin/companies/company_1/documents',
    })
    for (const notification of harness.tables.notifications) {
      expect(`${notification.title} ${notification.message}`).toContain('Andina Logistics')
      expect(`${notification.title} ${notification.message}`).not.toContain('Maintainer Gonzalez')
    }
  })

  it('sin aviso de esa sesión no escribe nada', async () => {
    const harness = createCtx(seedWithIntakeAlert())

    await attachCompanyToIntakeAlert(harness.ctx as never, {
      intakeSessionId: 'intake_1' as Id<'intakeSessions'>,
      companyId: COMPANY_ID,
    })

    expect(harness.tables.teamAlerts).toHaveLength(0)
    expect(harness.tables.notifications).toHaveLength(0)
  })
})

describe('teamAlerts — el aviso nombra a la empresa, no a su dueño', () => {
  beforeEach(() => {
    sendTeamAlertEmail.mockClear()
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  /** La sala recién provisionada: `companies.name` es el nombre del dueño. */
  function seedFreshWorkspace(): Tables {
    const seed = seedWithTwoAdmins()
    seed.companies[0].name = 'Maintainer Gonzalez'
    return seed
  }

  /** Lo que hace el claim del intake o el rename de la sala. */
  function renameCompany(harness: ReturnType<typeof createCtx>, name: string) {
    harness.tables.companies[0].name = name
    harness.tables.companyChecklist = [
      { _id: 'checklist_1', _creationTime: 6, companyId: 'company_1', nameConfirmedAt: NOW },
    ]
  }

  it('el correo sale con el nombre de la empresa al enviar, no con el del alta', async () => {
    const harness = createCtx(seedFreshWorkspace())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })
    expect(harness.tables.teamAlerts[0].companyName).toBe('Maintainer Gonzalez')
    for (const notification of harness.tables.notifications) {
      notification.isRead = true
    }

    // El nombre aterriza segundos después de abrir la tanda; el correo sale dos
    // minutos más tarde.
    renameCompany(harness, 'Grupo Calesa, S.A. y Subsidiarias')
    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>,
    })

    expect(sendTeamAlertEmail).toHaveBeenCalledTimes(2)
    for (const [, args] of sendTeamAlertEmail.mock.calls) {
      expect(args.companyName).toBe('Grupo Calesa, S.A. y Subsidiarias')
    }
    expect(harness.tables.teamAlerts[0].companyName).toBe('Grupo Calesa, S.A. y Subsidiarias')
    for (const notification of harness.tables.notifications) {
      expect(`${notification.title} ${notification.message}`).toContain('Grupo Calesa')
      // Corregir el nombre no es contenido nuevo: quien ya lo leyó lo leyó.
      expect(notification.isRead).toBe(true)
    }
  })

  it('sin nombre confirmado el aviso se queda con el que ya tenía', async () => {
    // `nameConfirmedAt` es la única evidencia de que el nombre lo puso una
    // persona. Un cambio que nadie confirmó (una reparación de operador con
    // `admin.setCompanyName`) no reescribe una tanda ya abierta.
    const harness = createCtx(seedFreshWorkspace())

    await recordVdrUpload(harness.ctx as never, {
      companyId: COMPANY_ID,
      fileName: 'estados-financieros-2025.pdf',
      folder: 'room_financial',
    })
    harness.tables.companies[0].name = 'Otro Nombre Cualquiera'
    await dispatchTeamAlertEmail(harness.ctx as never, {
      alertId: harness.tables.teamAlerts[0]._id as Id<'teamAlerts'>,
    })

    expect(sendTeamAlertEmail).toHaveBeenCalledTimes(2)
    for (const [, args] of sendTeamAlertEmail.mock.calls) {
      expect(args.companyName).toBe('Maintainer Gonzalez')
    }
  })
})
