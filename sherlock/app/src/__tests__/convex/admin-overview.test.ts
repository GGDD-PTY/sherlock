// ============================================================================
// ADMIN OVERVIEW — la vista general del equipo
// ============================================================================
// Contratos: (1) cada empresa rinde UNA fila con dueño, documentos por carpeta
// del shell, bytes de custodia, última subida y entregables del equipo;
// (2) los bytes salen de TODAS las versiones, no del último archivo, porque eso
// es lo que consume el plan Starter; (3) el aviso se marca leído según la
// campanita del ADMIN QUE MIRA, no la de su socio; (4) la bandeja de soporte
// solo trae hilos que esperan respuesta.
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { Id } from '../../../convex/_generated/dataModel'
import {
  CONVEX_STARTER_STORAGE_BYTES,
  buildAdminOverview,
  buildCompanyRows,
  buildConvexUsage,
  buildSupportInbox,
  buildTeamAlerts,
} from '../../../convex/_admin/overview'

const NOW = Date.UTC(2026, 8, 1, 15, 0, 0)
const HOUR = 60 * 60 * 1000

type Row = Record<string, unknown> & { _id: string; _creationTime: number }
type Tables = Record<string, Row[]>

function createCtx(seed: Tables = {}) {
  const tables: Tables = structuredClone(seed)

  const db = {
    async get(id: string) {
      return (
        Object.values(tables)
          .flat()
          .find((row) => row._id === id) ?? null
      )
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

  return { tables, ctx: { db } }
}

const ADMIN_PROFILE = 'profile_admin_1' as Id<'profiles'>
const PARTNER_PROFILE = 'profile_admin_2' as Id<'profiles'>

function baseSeed(): Tables {
  return {
    users: [
      { _id: 'user_admin_1', _creationTime: 1, email: 'fixture-4622a879@example.com' },
      { _id: 'user_admin_2', _creationTime: 2, email: 'fixture-cffeaf6c@example.com' },
      { _id: 'user_owner', _creationTime: 3, email: 'fixture-13520a4f@example.com' },
    ],
    profiles: [
      { _id: 'profile_admin_1', _creationTime: 1, userId: 'user_admin_1', role: 'ADMIN' },
      { _id: 'profile_admin_2', _creationTime: 2, userId: 'user_admin_2', role: 'ADMIN' },
      { _id: 'profile_owner', _creationTime: 3, userId: 'user_owner', role: 'COMPANY' },
    ],
    companies: [
      {
        _id: 'company_1',
        _creationTime: 10,
        ownerId: 'profile_owner',
        name: 'Sample Hydro',
      },
    ],
    companyChecklist: [
      {
        _id: 'checklist_1',
        _creationTime: 10,
        companyId: 'company_1',
        nameConfirmedAt: NOW - HOUR,
      },
    ],
    documents: [
      {
        _id: 'document_1',
        _creationTime: NOW - 5 * HOUR,
        companyId: 'company_1',
        name: 'estados-financieros-2025.pdf',
        folder: 'room_financial',
        currentVersionId: 'version_1',
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'document_2',
        _creationTime: NOW - 4 * HOUR,
        companyId: 'company_1',
        name: 'pacto-social.pdf',
        folder: 'legal',
        fileSize: 1_000,
        lifecycleStatus: 'ACTIVE',
      },
      {
        _id: 'document_3',
        _creationTime: NOW - 3 * HOUR,
        companyId: 'company_1',
        name: 'viejo.pdf',
        folder: 'room_legal',
        fileSize: 9_999,
        lifecycleStatus: 'ARCHIVED',
      },
    ],
    documentVersions: [
      {
        _id: 'version_1',
        _creationTime: NOW - 5 * HOUR,
        documentId: 'document_1',
        companyId: 'company_1',
        versionNumber: 1,
        byteSize: 2_000,
        createdAt: NOW - 5 * HOUR,
      },
      {
        _id: 'version_2',
        _creationTime: NOW - 1 * HOUR,
        documentId: 'document_1',
        companyId: 'company_1',
        versionNumber: 2,
        byteSize: 3_000,
        createdAt: NOW - 1 * HOUR,
        deliveryLabel: 'Modelo v1',
      },
    ],
    supportThreads: [],
    supportMessages: [],
    teamAlerts: [],
    notifications: [],
  }
}

describe('adminOverview — tabla de empresas', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('rinde una fila con dueño, carpetas del shell, bytes y última subida', async () => {
    const harness = createCtx(baseSeed())

    const { rows, truncated } = await buildCompanyRows(harness.ctx as never)

    expect(truncated).toBe(false)
    expect(rows).toHaveLength(1)
    const [row] = rows
    expect(row.name).toBe('Sample Hydro')
    expect(row.ownerEmail).toBe('fixture-13520a4f@example.com')
    // El archivado no cuenta ni en el total ni en su carpeta.
    expect(row.documentsTotal).toBe(2)
    expect(row.documentsByFolder).toEqual({
      room_legal: 1,
      room_corporate: 0,
      room_financial: 1,
      room_operations: 0,
      room_marketing: 0,
    })
    // 2.000 + 3.000 de las dos versiones + 1.000 del documento legacy sin versión.
    expect(row.storageBytes).toBe(6_000)
    expect(row.lastUploadAt).toBe(NOW - HOUR)
    expect(row.deliverableVersions).toBe(1)
    expect(row.supportUnread).toBe(0)
  })

  it('cuenta los mensajes de soporte sin leer de la empresa en su propia fila', async () => {
    const seed = baseSeed()
    seed.supportThreads = [
      {
        _id: 'thread_1',
        _creationTime: NOW,
        scope: { kind: 'COMPANY', companyId: 'company_1' },
        scopeKey: 'company:company_1',
        adminUnread: true,
        adminUnreadCount: 3,
        lastMessageAt: NOW - HOUR,
      },
    ]
    const harness = createCtx(seed)

    const { rows } = await buildCompanyRows(harness.ctx as never)

    expect(rows[0]?.supportUnread).toBe(3)
  })

  it('pone primero la sala que se movió de último', async () => {
    const seed = baseSeed()
    seed.companies.push({
      _id: 'company_2',
      _creationTime: 11,
      ownerId: 'profile_owner',
      name: 'Andina Holdings',
    })
    seed.documents.push({
      _id: 'document_4',
      _creationTime: NOW - 10 * HOUR,
      companyId: 'company_2',
      name: 'teaser.pdf',
      folder: 'room_marketing',
      fileSize: 500,
      lifecycleStatus: 'ACTIVE',
    })
    const harness = createCtx(seed)

    const { rows } = await buildCompanyRows(harness.ctx as never)

    expect(rows.map((row) => row.name)).toEqual(['Sample Hydro', 'Andina Holdings'])
  })
})

describe('adminOverview — avisos al equipo', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it.each([
    {
      confirmed: true,
      companyId: 'company_1',
      expected: 'Agroindustria Demo',
      checklist: baseSeed().companyChecklist,
      kind: 'COMPANY_WORKSPACE_CREATED',
      companyName: 'user_demo_provisional',
    },
    {
      confirmed: false,
      companyId: 'company_1',
      expected: 'Empresa sin identificar',
      checklist: [],
      kind: 'COMPANY_WORKSPACE_CREATED',
      companyName: 'user_demo_provisional',
    },
    {
      confirmed: false,
      companyId: undefined,
      expected: 'Empresa declarada en intake',
      checklist: [],
      kind: 'COMPANY_DOCUMENTS_UPLOADED',
      companyName: 'Empresa declarada en intake',
    },
  ])(
    'resuelve el nombre de alerta con $confirmed y $companyId',
    async ({ companyId, expected, checklist, kind, companyName }) => {
      const seed = baseSeed()
      seed.companies[0].name = 'Agroindustria Demo'
      seed.companyChecklist = checklist
      seed.teamAlerts = [
        {
          _id: 'alert_name',
          _creationTime: 1,
          kind,
          companyId,
          companyName,
          link: '/admin/companies',
          fileCount: 0,
          folders: [],
          notificationIds: [],
          openedAt: NOW,
          lastEventAt: NOW,
        },
      ]
      const harness = createCtx(seed)
      const originalEvents = structuredClone(harness.tables.teamAlerts)

      const [alert] = await buildTeamAlerts(harness.ctx as never, ADMIN_PROFILE)

      expect(alert.companyName).toBe(expected)
      expect(harness.tables.teamAlerts).toEqual(originalEvents)
    }
  )

  it('marca leído según la campanita de quien mira, no la de su socio', async () => {
    const seed = baseSeed()
    seed.notifications = [
      { _id: 'notification_1', _creationTime: 1, userId: 'profile_admin_1', isRead: true },
      { _id: 'notification_2', _creationTime: 2, userId: 'profile_admin_2', isRead: false },
    ]
    seed.teamAlerts = [
      {
        _id: 'alert_1',
        _creationTime: 1,
        kind: 'COMPANY_DOCUMENTS_UPLOADED',
        batchKey: 'vdr:company_1',
        companyId: 'company_1',
        companyName: 'Sample Hydro',
        link: '/admin/companies/company_1/documents',
        fileCount: 2,
        folders: ['Financieros'],
        fileNames: ['a.pdf', 'b.pdf'],
        notificationIds: ['notification_1', 'notification_2'],
        openedAt: NOW - HOUR,
        lastEventAt: NOW - HOUR,
      },
    ]
    const harness = createCtx(seed)

    const [mine] = await buildTeamAlerts(harness.ctx as never, ADMIN_PROFILE)
    const [partners] = await buildTeamAlerts(harness.ctx as never, PARTNER_PROFILE)

    expect(mine.isRead).toBe(true)
    expect(partners.isRead).toBe(false)
    expect(mine.companyName).toBe('Sample Hydro')
    expect(mine.fileCount).toBe(2)
    expect(mine.link).toBe('/admin/companies/company_1/documents')
  })

  it('trata como leído el aviso cuya campanita ya no existe', async () => {
    const seed = baseSeed()
    seed.teamAlerts = [
      {
        _id: 'alert_1',
        _creationTime: 1,
        kind: 'COMPANY_WORKSPACE_CREATED',
        batchKey: 'workspace:company_1',
        companyId: 'company_1',
        companyName: 'Sample Hydro',
        link: '/admin/companies/company_1/documents',
        fileCount: 0,
        folders: [],
        fileNames: [],
        notificationIds: ['notification_borrada'],
        openedAt: NOW - HOUR,
        lastEventAt: NOW - HOUR,
      },
    ]
    const harness = createCtx(seed)

    const [alert] = await buildTeamAlerts(harness.ctx as never, ADMIN_PROFILE)

    expect(alert.isRead).toBe(true)
  })

  // Una tanda abierta cuando el deployment no tenía ni un ADMIN nace con
  // `notificationIds: []`. Esa fila es el ÚNICO registro de que el cliente se
  // movió, y existe para que el equipo que se dé de alta después la vea: darla
  // por leída la enterraba en el mismo silencio que venía a romper.
  it('el aviso que nunca repartió campanitas llega sin leer', async () => {
    const seed = baseSeed()
    seed.teamAlerts = [
      {
        _id: 'alert_sin_destinatarios',
        _creationTime: 1,
        kind: 'COMPANY_DOCUMENTS_UPLOADED',
        batchKey: 'vdr:company_1',
        companyId: 'company_1',
        companyName: 'Sample Hydro',
        link: '/admin/companies/company_1/documents',
        fileCount: 3,
        folders: ['Financieros'],
        fileNames: ['a.pdf', 'b.pdf', 'c.pdf'],
        notificationIds: [],
        openedAt: NOW - HOUR,
        lastEventAt: NOW - HOUR,
      },
    ]
    const harness = createCtx(seed)

    const [alert] = await buildTeamAlerts(harness.ctx as never, ADMIN_PROFILE)

    expect(alert.isRead).toBe(false)
  })
})

describe('adminOverview — bandeja de soporte', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('solo trae hilos que esperan respuesta del equipo, con su empresa', async () => {
    const seed = baseSeed()
    seed.supportThreads = [
      {
        _id: 'thread_leido',
        _creationTime: 1,
        scope: { kind: 'COMPANY', companyId: 'company_1' },
        scopeKey: 'company:company_1',
        adminUnread: false,
        adminUnreadCount: 0,
        lastMessageAt: NOW - 5 * HOUR,
      },
      {
        _id: 'thread_intake',
        _creationTime: 2,
        scope: { kind: 'INTAKE', intakeSessionId: 'intake_1' },
        scopeKey: 'intake:intake_1',
        adminUnread: true,
        adminUnreadCount: 2,
        lastMessageAt: NOW - 2 * HOUR,
      },
    ]
    const harness = createCtx(seed)

    const inbox = await buildSupportInbox(harness.ctx as never)

    expect(inbox.unreadThreads).toBe(1)
    expect(inbox.unreadMessages).toBe(2)
    expect(inbox.threads[0]?.scopeKind).toBe('INTAKE')
    expect(inbox.threads[0]?.roomLabel).toBeNull()
  })
})

describe('adminOverview — consumo de Convex', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  it('suma documentos y bytes de las filas ya leídas y cuenta perfiles por rol', async () => {
    const harness = createCtx(baseSeed())
    const { rows, truncated } = await buildCompanyRows(harness.ctx as never)

    const usage = await buildConvexUsage(harness.ctx as never, rows, truncated)

    expect(usage.companies).toBe(1)
    expect(usage.documents).toBe(2)
    expect(usage.storageBytes).toBe(6_000)
    expect(usage.storageCapBytes).toBe(CONVEX_STARTER_STORAGE_BYTES)
    expect(usage.usersByRole).toEqual({ ADMIN: 2, COMPANY: 1 })
    expect(usage.truncated).toBe(false)
  })

  it('arma la vista completa en una sola lectura', async () => {
    const harness = createCtx(baseSeed())

    const overview = await buildAdminOverview(harness.ctx as never, ADMIN_PROFILE)

    expect(overview.companies).toHaveLength(1)
    expect(overview.alerts).toEqual([])
    expect(overview.support.unreadThreads).toBe(0)
    expect(overview.usage.storageBytes).toBe(6_000)
    expect(overview.coverage.truncated).toBe(false)
    expect(overview.generatedAt).toBe(NOW)
  })
})
