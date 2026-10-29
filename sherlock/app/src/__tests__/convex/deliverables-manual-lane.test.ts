// ============================================================================
// DELIVERABLES — carril manual: authz de entrada, idempotencia y proyección
// ============================================================================
// `deliverables-authz-contract.test.ts` solo inspecciona el texto del facade y
// `deliverables-workflow.test.ts` cubre la custodia de renditions al aprobar y
// entregar. Falta el otro lado: quién puede abrir un slot, sobre qué empresa,
// cuántas veces, y qué campos ve la empresa cuando lista. Un refactor que
// conserve `requireAuthAdmin(ctx)` pero deje de derivar la empresa de la fila
// propia, pierda la idempotencia por (empresa, kind) o filtre el manifiesto de
// insumos en la proyección, no puede quedarse verde.

import { ConvexError } from 'convex/values'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// El correo del cliente sale por `sendProductEmail`, que en test está apagado
// por env: mockearlo es lo que deja ver que la entrega manual SÍ lo intenta, y
// una sola vez.
const sendProductEmail = vi.fn(async (_ctx: unknown, _args: unknown): Promise<void> => undefined)
vi.mock('../../../convex/email', () => ({
  sendProductEmail: (ctx: unknown, args: unknown) => sendProductEmail(ctx, args),
}))

import {
  attachRendition,
  listForCompany,
  markDocumentAsDelivery,
  request,
  transition,
} from '../../../convex/deliverables'
import { ErrorCode } from '../../../convex/_helpers/errors'
import {
  createConvexCtx,
  runHandler,
  runMutationHandlerWithOcc,
  type Tables,
} from './nda-convex-harness'

const OWNER_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_owner',
  email: 'fixture-adfd7e27@example.com',
}
const OUTSIDER_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_outsider',
  email: 'fixture-669e5e9a@example.com',
}
const ADMIN_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_admin',
  email: 'fixture-dbeda5ff@example.com',
}
const INVESTOR_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_investor',
  email: 'fixture-39e73858@example.com',
}

/** Documento entregable vigente: ACTIVE, con versión publicada y verificada. */
function usableDocument(id: string, companyId = 'company_1') {
  return {
    _id: id,
    companyId,
    name: `${id}.bin`,
    lifecycleStatus: 'ACTIVE',
    storageId: `storage_${id}`,
    currentVersionId: `version_${id}`,
    publishedVersionId: `version_${id}`,
  }
}

function usableVersion(documentId: string, companyId = 'company_1') {
  return {
    _id: `version_${documentId}`,
    documentId,
    companyId,
    versionNumber: 1,
    storageId: `storage_${documentId}`,
    publicationStatus: 'PUBLISHED',
    verificationStatus: 'SIGNATURE_VERIFIED',
    malwareScanStatus: 'CLEAN',
  }
}

function seed(overrides: Tables = {}): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'fixture-adfd7e27@example.com',
      },
      {
        _id: 'user_outsider',
        authProvider: 'workos',
        providerUserId: 'workos_outsider',
        workosUserId: 'workos_outsider',
        email: 'fixture-669e5e9a@example.com',
      },
      {
        _id: 'user_admin',
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'fixture-dbeda5ff@example.com',
      },
      {
        _id: 'user_investor',
        authProvider: 'workos',
        providerUserId: 'workos_investor',
        workosUserId: 'workos_investor',
        email: 'fixture-39e73858@example.com',
      },
    ],
    profiles: [
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true },
      { _id: 'profile_outsider', userId: 'user_outsider', role: 'COMPANY', isActive: true },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
      { _id: 'profile_investor', userId: 'user_investor', role: 'COMPANY', isActive: true },
    ],
    companies: [
      { _id: 'company_1', ownerId: 'profile_owner', name: 'Company One' },
      { _id: 'company_2', ownerId: 'profile_outsider', name: 'Company Two' },
    ],
    documents: [
      usableDocument('doc_own'),
      usableDocument('doc_own_pdf'),
      usableDocument('doc_other', 'company_2'),
    ],
    documentVersions: [
      usableVersion('doc_own'),
      usableVersion('doc_own_pdf'),
      usableVersion('doc_other', 'company_2'),
    ],
    deliverables: [],
    rateLimits: [],
    adminAuditLogs: [],
    ...overrides,
  }
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  let thrown: unknown
  try {
    await fn()
  } catch (error) {
    thrown = error
  }
  expect(thrown, 'expected the handler to throw').toBeDefined()
  expect((thrown as { data?: { code?: string } }).data?.code).toBe(code)
}

describe('deliverables.request', () => {
  it('lets the company owner open a REQUESTED slot derived from its own row', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    const result = await runHandler<
      { kind: 'TEASER' },
      { deliverableId: string; status: string; created: boolean }
    >(request, ctx, { kind: 'TEASER' })

    expect(result).toMatchObject({ status: 'REQUESTED', created: true })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({
      companyId: 'company_1',
      kind: 'TEASER',
      status: 'REQUESTED',
      requestedByProfileId: 'profile_owner',
    })
  })

  it('rejects a company that names another companyId', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expectCode(
      () => runHandler(request, ctx, { kind: 'CIM', companyId: 'company_2' }),
      ErrorCode.AUTHZ_UNAUTHORIZED
    )
    expect(tables.deliverables).toHaveLength(0)
  })

  it('rejects a revoked owner whose profile is still active', async () => {
    const tables = seed({
      organizationMemberships: [
        {
          _id: 'membership_owner',
          userId: 'user_owner',
          profileId: 'profile_owner',
          authProvider: 'workos',
          providerOrgId: 'org_owner',
          workosOrgId: 'org_owner',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'INACTIVE',
          providerUpdatedAt: 100,
          createdAt: 10,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expectCode(() => runHandler(request, ctx, { kind: 'TEASER' }), ErrorCode.AUTHZ_UNAUTHORIZED)
    expect(tables.deliverables).toHaveLength(0)
  })

  it('lets an owner with one active owner membership open a slot', async () => {
    const tables = seed({
      organizationMemberships: [
        {
          _id: 'membership_owner',
          userId: 'user_owner',
          profileId: 'profile_owner',
          authProvider: 'workos',
          providerOrgId: 'org_owner',
          workosOrgId: 'org_owner',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'ACTIVE',
          createdAt: 10,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expect(runHandler(request, ctx, { kind: 'TEASER' })).resolves.toMatchObject({
      status: 'REQUESTED',
      created: true,
    })
    expect(tables.deliverables[0]).toMatchObject({ companyId: 'company_1' })
  })

  it('rejects a profile without a company row before any insert', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: INVESTOR_IDENTITY })

    await expectCode(
      () => runHandler(request, ctx, { kind: 'MODEL' }),
      ErrorCode.BUSINESS_MISSING_PROFILE
    )
    expect(tables.deliverables).toHaveLength(0)
  })

  it('requires an admin to name an existing company', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expectCode(
      () => runHandler(request, ctx, { kind: 'TEASER' }),
      ErrorCode.VALIDATION_FAILED
    )
    await expectCode(
      () => runHandler(request, ctx, { kind: 'TEASER', companyId: 'company_missing' }),
      ErrorCode.NOT_FOUND
    )
    expect(tables.deliverables).toHaveLength(0)

    const created = await runHandler<
      { kind: 'TEASER'; companyId: string },
      { created: boolean; status: string }
    >(request, ctx, { kind: 'TEASER', companyId: 'company_1' })
    expect(created).toMatchObject({ created: true, status: 'REQUESTED' })
    expect(tables.deliverables[0]).toMatchObject({
      companyId: 'company_1',
      requestedByProfileId: 'profile_admin',
    })
  })

  it('is idempotent per (company, kind) — a second request returns the live slot', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_teaser',
          _creationTime: 10,
          companyId: 'company_1',
          kind: 'TEASER',
          status: 'IN_REVIEW',
          requestedByProfileId: 'profile_owner',
          updatedAt: 10,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    const result = await runHandler<
      { kind: 'TEASER' },
      { deliverableId: string; status: string; created: boolean }
    >(request, ctx, { kind: 'TEASER' })

    expect(result).toEqual({
      deliverableId: 'del_teaser',
      status: 'IN_REVIEW',
      created: false,
    })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]?.status).toBe('IN_REVIEW')
  })

  it('serializes concurrent requests for the same kind into a single slot', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    const [first, second] = await Promise.all([
      runMutationHandlerWithOcc<{ kind: 'MODEL' }, { created: boolean }>(request, ctx, {
        kind: 'MODEL',
      }),
      runMutationHandlerWithOcc<{ kind: 'MODEL' }, { created: boolean }>(request, ctx, {
        kind: 'MODEL',
      }),
    ])

    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(tables.deliverables.filter((row) => row.kind === 'MODEL')).toHaveLength(1)
  })

  it('rate-limits slot creation per profile', async () => {
    const tables = seed({
      rateLimits: [
        {
          _id: 'rl_owner',
          key: 'deliverablesRequest:profile_owner',
          count: 30,
          windowStart: Date.now(),
          windowMs: 60 * 60 * 1000,
          lastHitAt: Date.now(),
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expect(runHandler(request, ctx, { kind: 'DEBT_DECK' })).rejects.toBeInstanceOf(
      ConvexError
    )
    expect(tables.deliverables).toHaveLength(0)
  })
})

describe('deliverables.transition', () => {
  it('rejects a company user before reading the slot', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_1',
          companyId: 'company_1',
          kind: 'TEASER',
          status: 'REQUESTED',
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expectCode(
      () => runHandler(transition, ctx, { deliverableId: 'del_1', to: 'IN_PROGRESS' }),
      ErrorCode.AUTHZ_ADMIN_REQUIRED
    )
    expect(tables.deliverables[0]?.status).toBe('REQUESTED')
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('refuses a shortcut that skips human review and leaves the row untouched', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_1',
          companyId: 'company_1',
          kind: 'CIM',
          status: 'DRAFT_READY',
          renditions: [{ format: 'HTML', documentId: 'doc_own' }],
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expectCode(
      () => runHandler(transition, ctx, { deliverableId: 'del_1', to: 'APPROVED' }),
      ErrorCode.BUSINESS_INVALID_STATE
    )
    expect(tables.deliverables[0]).toMatchObject({ status: 'DRAFT_READY' })
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('stamps reviewer and timestamps only on the human approval and delivery', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_1',
          companyId: 'company_1',
          kind: 'MODEL',
          status: 'IN_REVIEW',
          renditions: [{ format: 'XLSX', documentId: 'doc_own' }],
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await runHandler(transition, ctx, { deliverableId: 'del_1', to: 'APPROVED' })
    expect(tables.deliverables[0]).toMatchObject({
      status: 'APPROVED',
      reviewedByProfileId: 'profile_admin',
    })
    expect(typeof tables.deliverables[0]?.approvedAt).toBe('number')
    expect(tables.deliverables[0]?.deliveredAt).toBeUndefined()

    await runHandler(transition, ctx, { deliverableId: 'del_1', to: 'DELIVERED' })
    expect(tables.deliverables[0]).toMatchObject({ status: 'DELIVERED' })
    expect(typeof tables.deliverables[0]?.deliveredAt).toBe('number')

    // `previousValue` se lee de `deliverable.status` DESPUÉS del patch: el
    // harness devuelve la fila viva, Convex un snapshot. El pin durable es
    // `newValue` (sale de `args.to`) más destinatario y autor.
    expect(tables.adminAuditLogs).toEqual([
      expect.objectContaining({
        action: 'DELIVERABLE_TRANSITION',
        targetType: 'DELIVERABLE',
        targetId: 'del_1',
        newValue: { status: 'APPROVED' },
        adminProfileId: 'profile_admin',
      }),
      expect.objectContaining({
        action: 'DELIVERABLE_TRANSITION',
        targetType: 'DELIVERABLE',
        targetId: 'del_1',
        newValue: { status: 'DELIVERED' },
        adminProfileId: 'profile_admin',
      }),
    ])
  })
})

describe('deliverables.attachRendition', () => {
  it('rejects a document that belongs to another company before patching', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_1',
          companyId: 'company_1',
          kind: 'CIM',
          status: 'IN_PROGRESS',
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expectCode(
      () =>
        runHandler(attachRendition, ctx, {
          deliverableId: 'del_1',
          format: 'HTML',
          documentId: 'doc_other',
        }),
      ErrorCode.AUTHZ_UNAUTHORIZED
    )
    expect(tables.deliverables[0]?.renditions).toBeUndefined()
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('replaces the same format, keeps a Mycroft producer, and swaps the manifest whole', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_1',
          companyId: 'company_1',
          kind: 'TEASER',
          status: 'DRAFT_READY',
          producedBy: 'MYCROFT_RUN',
          renditions: [{ format: 'HTML', documentId: 'doc_own' }],
          inputManifest: ['version_doc_own'],
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const first = await runHandler<
      { deliverableId: string; format: 'HTML'; documentId: string },
      { renditionCount: number }
    >(attachRendition, ctx, {
      deliverableId: 'del_1',
      format: 'HTML',
      documentId: 'doc_own',
    })
    expect(first.renditionCount).toBe(1)
    expect(tables.deliverables[0]).toMatchObject({
      producedBy: 'MYCROFT_RUN',
      inputManifest: ['version_doc_own'],
      renditions: [{ format: 'HTML', documentId: 'doc_own' }],
    })

    const second = await runHandler<
      { deliverableId: string; format: 'PDF'; documentId: string; inputManifest: string[] },
      { renditionCount: number }
    >(attachRendition, ctx, {
      deliverableId: 'del_1',
      format: 'PDF',
      documentId: 'doc_own_pdf',
      inputManifest: ['version_doc_own_pdf'],
    })
    expect(second.renditionCount).toBe(2)
    expect(tables.deliverables[0]?.renditions).toEqual([
      { format: 'HTML', documentId: 'doc_own' },
      { format: 'PDF', documentId: 'doc_own_pdf' },
    ])
    expect(tables.deliverables[0]?.inputManifest).toEqual(['version_doc_own_pdf'])
    expect(tables.deliverables[0]?.producedBy).toBe('MYCROFT_RUN')
    expect(tables.adminAuditLogs.at(-1)).toMatchObject({
      action: 'DELIVERABLE_RENDITION_ATTACH',
      targetType: 'DELIVERABLE',
      newValue: { format: 'PDF', documentId: 'doc_own_pdf' },
    })
  })

  it('defaults producedBy to TEAM only when the slot has no producer yet', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_1',
          companyId: 'company_1',
          kind: 'EQUITY_DECK',
          status: 'IN_PROGRESS',
          updatedAt: 1,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await runHandler(attachRendition, ctx, {
      deliverableId: 'del_1',
      format: 'HTML',
      documentId: 'doc_own',
    })
    expect(tables.deliverables[0]?.producedBy).toBe('TEAM')
  })
})

describe('deliverables.listForCompany', () => {
  it('hides the slot list from a revoked owner whose profile is still active', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_model',
          companyId: 'company_1',
          kind: 'MODEL',
          status: 'DELIVERED',
          updatedAt: 21,
        },
      ],
      organizationMemberships: [
        {
          _id: 'membership_owner',
          userId: 'user_owner',
          profileId: 'profile_owner',
          authProvider: 'workos',
          providerOrgId: 'org_owner',
          workosOrgId: 'org_owner',
          betaRole: 'COMPANY_OWNER',
          profileRole: 'COMPANY',
          status: 'INACTIVE',
          providerUpdatedAt: 100,
          createdAt: 10,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expectCode(() => runHandler(listForCompany, ctx, {}), ErrorCode.AUTHZ_UNAUTHORIZED)
  })

  it('lets the owner see only a whitelist, in suite order', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'del_equity',
          companyId: 'company_1',
          kind: 'EQUITY_DECK',
          status: 'REQUESTED',
          requestedByProfileId: 'profile_owner',
          reviewedByProfileId: 'profile_admin',
          inputManifest: ['version_doc_own'],
          modelRunId: 'run_hidden',
          updatedAt: 30,
        },
        {
          _id: 'del_model',
          companyId: 'company_1',
          kind: 'MODEL',
          status: 'DELIVERED',
          producedBy: 'TEAM',
          renditions: [{ format: 'XLSX', documentId: 'doc_own' }],
          approvedAt: 20,
          deliveredAt: 21,
          updatedAt: 21,
        },
        {
          _id: 'del_other',
          companyId: 'company_2',
          kind: 'TEASER',
          status: 'APPROVED',
          updatedAt: 5,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    const rows = await runHandler<Record<string, never>, Array<Record<string, unknown>>>(
      listForCompany,
      ctx,
      {}
    )

    expect(rows.map((row) => row.kind)).toEqual(['MODEL', 'EQUITY_DECK'])
    expect(rows[0]).toEqual({
      deliverableId: 'del_model',
      kind: 'MODEL',
      status: 'DELIVERED',
      producedBy: 'TEAM',
      // au-02: la proyección lleva versionId para que Entregado abra esa versión.
      renditions: [{ format: 'XLSX', documentId: 'doc_own', versionId: 'version_doc_own' }],
      sources: [],
      sourcesTruncated: false,
      deliveryNote: null,
      approvedAt: 20,
      deliveredAt: 21,
      updatedAt: 21,
    })
    // El manifiesto sale resuelto (`sources`), nunca crudo, y los campos de
    // flujo interno no cruzan la frontera.
    expect(rows[1]?.sources).toEqual([
      { documentId: 'doc_own', name: 'doc_own.bin', versionNumber: 1 },
    ])
    expect(rows[1]).not.toHaveProperty('requestedByProfileId')
    expect(rows[1]).not.toHaveProperty('reviewedByProfileId')
    expect(rows[1]).not.toHaveProperty('inputManifest')
    expect(rows[1]).not.toHaveProperty('modelRunId')
    expect(rows[1]).not.toHaveProperty('companyId')
  })

  // La nota del equipo viaja en la versión del documento que el slot cita: el
  // rail del cliente la lee bajo la etapa entregada sin abrir la sala.
  it('carries the team note of the delivered version and nothing for the rest', async () => {
    const tables = seed({
      documentVersions: [
        { ...usableVersion('doc_own'), deliveryNote: 'Modelo v1 listo para revisión.' },
        usableVersion('doc_own_pdf'),
      ],
      deliverables: [
        {
          _id: 'del_model',
          companyId: 'company_1',
          kind: 'MODEL',
          status: 'DELIVERED',
          producedBy: 'TEAM',
          renditions: [{ format: 'XLSX', documentId: 'doc_own' }],
          updatedAt: 21,
        },
        {
          _id: 'del_teaser',
          companyId: 'company_1',
          kind: 'TEASER',
          status: 'IN_REVIEW',
          renditions: [{ format: 'PDF', documentId: 'doc_own_pdf' }],
          updatedAt: 22,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    const rows = await runHandler<Record<string, never>, Array<Record<string, unknown>>>(
      listForCompany,
      ctx,
      {}
    )

    expect(rows.map((row) => [row.kind, row.deliveryNote])).toEqual([
      ['MODEL', 'Modelo v1 listo para revisión.'],
      ['TEASER', null],
    ])
  })

  it('rejects a company listing another company and an admin without companyId', async () => {
    const ownerCtx = createConvexCtx(seed(), { identity: OWNER_IDENTITY })
    await expectCode(
      () => runHandler(listForCompany, ownerCtx, { companyId: 'company_2' }),
      ErrorCode.AUTHZ_UNAUTHORIZED
    )

    const adminCtx = createConvexCtx(seed(), { identity: ADMIN_IDENTITY })
    await expectCode(() => runHandler(listForCompany, adminCtx, {}), ErrorCode.VALIDATION_FAILED)

    const outsiderCtx = createConvexCtx(seed(), { identity: OUTSIDER_IDENTITY })
    const outsiderRows = await runHandler<Record<string, never>, Array<{ kind: string }>>(
      listForCompany,
      outsiderCtx,
      {}
    )
    expect(outsiderRows).toEqual([])
  })
})

// ============================================================================
// MARCAR COMO ENTREGA — el camino manual del equipo, sin terminal
// ============================================================================
// El fundador baja el zip de la sala, corre Mycroft y sube el entregable por
// «Subir documento». Hasta acá eso dejaba el rail en «Entregas 0» y al cliente
// sin aviso: la entrega sólo existía por `bun run vdr:push --slot`. Esta
// mutation es esa misma entrega, hecha desde la UI y sobre un documento que ya
// está en la sala.

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const NOTE = 'Modelo v1. Revisa los supuestos antes de la llamada.'

function deliverySeed(overrides: Tables = {}): Tables {
  return seed({
    documents: [{ ...usableDocument('doc_model'), name: 'Modelo financiero v1' }],
    documentVersions: [
      { ...usableVersion('doc_model'), declaredMimeType: XLSX_MIME, detectedMimeType: XLSX_MIME },
    ],
    notifications: [],
    ...overrides,
  })
}

describe('deliverables.markDocumentAsDelivery', () => {
  beforeEach(() => {
    sendProductEmail.mockClear()
  })

  it('delivers the slot, stamps the version and rings the client once', async () => {
    const tables = deliverySeed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const result = await runHandler<
      { documentId: string; kind: 'MODEL'; note: string },
      { status: string; delivered: boolean }
    >(markDocumentAsDelivery, ctx, { documentId: 'doc_model', kind: 'MODEL', note: NOTE })

    expect(result).toMatchObject({ status: 'DELIVERED', delivered: true })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({
      companyId: 'company_1',
      kind: 'MODEL',
      status: 'DELIVERED',
      producedBy: 'TEAM',
      renditions: [{ format: 'XLSX', documentId: 'doc_model' }],
      reviewedByProfileId: 'profile_admin',
    })
    // El sello viaja en la versión: es lo que el cliente ve y lo que hace
    // idempotente un segundo clic.
    expect(tables.documentVersions[0].deliveryNote).toBe(NOTE)
    // La procedencia es un campo: lo que se marca como entrega lo devolvió el equipo.
    expect(tables.documents.find((row) => row._id === 'doc_model')?.sourceType).toBe(
      'TEAM_DELIVERABLE'
    )
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({
      userId: 'profile_owner',
      type: 'document_shared',
      title: 'Nuevo en tu sala',
      message: 'El equipo publicó un documento en tu sala. Ábrelo para revisarlo.',
      entityId: 'version_doc_model',
    })
    expect(sendProductEmail).toHaveBeenCalledTimes(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.adminAuditLogs[0]).toMatchObject({
      action: 'DELIVERABLE_TRANSITION',
      targetType: 'DELIVERABLE',
      adminProfileId: 'profile_admin',
    })
  })

  it('is idempotent per version: a second mark neither re-delivers nor rings again', async () => {
    const tables = deliverySeed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    const args = { documentId: 'doc_model', kind: 'MODEL' as const, note: NOTE }

    await runHandler(markDocumentAsDelivery, ctx, args)
    const deliveredAt = tables.deliverables[0].updatedAt
    const second = await runHandler<typeof args, { delivered: boolean; status: string }>(
      markDocumentAsDelivery,
      ctx,
      args
    )

    expect(second).toMatchObject({ delivered: false, status: 'DELIVERED' })
    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0].updatedAt).toBe(deliveredAt)
    expect(tables.notifications).toHaveLength(1)
    expect(sendProductEmail).toHaveBeenCalledTimes(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('keeps the first note when the same slot is marked again with another one', async () => {
    const tables = deliverySeed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(markDocumentAsDelivery, ctx, {
      documentId: 'doc_model',
      kind: 'MODEL',
      note: NOTE,
    })

    const second = await runHandler<
      { documentId: string; kind: 'MODEL'; note: string },
      { delivered: boolean; status: string }
    >(markDocumentAsDelivery, ctx, {
      documentId: 'doc_model',
      kind: 'MODEL',
      note: 'Otra nota, escrita después de que el cliente ya leyó la primera.',
    })

    // El sello es de la versión que YA salió. La campanita no lleva la nota;
    // la versión conserva la primera.
    expect(second).toMatchObject({ delivered: false, status: 'DELIVERED' })
    expect(tables.documentVersions[0].deliveryNote).toBe(NOTE)
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0].message).not.toContain(NOTE)
    expect(tables.notifications[0].message).not.toContain('Otra nota')
    expect(sendProductEmail).toHaveBeenCalledTimes(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('refuses to re-mark a delivered version as another kind', async () => {
    const tables = deliverySeed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(markDocumentAsDelivery, ctx, {
      documentId: 'doc_model',
      kind: 'MODEL',
      note: NOTE,
    })

    // Cada fila del panel reusa el mismo selector de documentos: marcar el xlsx
    // del modelo desde la fila del teaser está a un clic. Dejarlo pasar ponía el
    // TEASER en «Entregado» con el archivo del modelo, pisaba la nota de la
    // versión y devolvía `delivered: true` sin que la campanita volviera a sonar.
    await expectCode(
      () =>
        runHandler(markDocumentAsDelivery, ctx, {
          documentId: 'doc_model',
          kind: 'TEASER',
          note: 'Teaser listo para revisión.',
        }),
      ErrorCode.BUSINESS_INVALID_STATE
    )

    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({ kind: 'MODEL', status: 'DELIVERED' })
    expect(tables.documentVersions[0].deliveryNote).toBe(NOTE)
    expect(tables.notifications).toHaveLength(1)
    expect(sendProductEmail).toHaveBeenCalledTimes(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('reopens the cycle when the document already has a newer, unstamped version', async () => {
    const tables = deliverySeed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(markDocumentAsDelivery, ctx, {
      documentId: 'doc_model',
      kind: 'MODEL',
      note: NOTE,
    })

    // La v2 entra como la versión vigente del mismo documento: el sello de la
    // v1 no puede silenciar la entrega de la v2.
    tables.documentVersions.push({
      ...usableVersion('doc_model'),
      _id: 'version_doc_model_v2',
      versionNumber: 2,
      declaredMimeType: XLSX_MIME,
      detectedMimeType: XLSX_MIME,
    })
    tables.documents[0].currentVersionId = 'version_doc_model_v2'
    tables.documents[0].publishedVersionId = 'version_doc_model_v2'

    const second = await runHandler<Record<string, unknown>, { delivered: boolean }>(
      markDocumentAsDelivery,
      ctx,
      { documentId: 'doc_model', kind: 'MODEL', note: 'Modelo v2 con la nota corregida.' }
    )

    expect(second.delivered).toBe(true)
    expect(tables.notifications).toHaveLength(2)
    expect(sendProductEmail).toHaveBeenCalledTimes(2)
  })

  it('refuses a new version of a delivered document as another kind', async () => {
    const tables = deliverySeed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })
    await runHandler(markDocumentAsDelivery, ctx, {
      documentId: 'doc_model',
      kind: 'MODEL',
      note: NOTE,
    })

    // La v2 sin sello es el atajo que quedaba abierto: el documento ya salió
    // como MODEL, así que subir otra versión del mismo archivo no le gana un
    // segundo slot. El corte es por documento, no por versión.
    tables.documentVersions.push({
      ...usableVersion('doc_model'),
      _id: 'version_doc_model_v2',
      versionNumber: 2,
      declaredMimeType: XLSX_MIME,
      detectedMimeType: XLSX_MIME,
    })
    tables.documents[0].currentVersionId = 'version_doc_model_v2'
    tables.documents[0].publishedVersionId = 'version_doc_model_v2'

    await expectCode(
      () =>
        runHandler(markDocumentAsDelivery, ctx, {
          documentId: 'doc_model',
          kind: 'TEASER',
          note: 'Teaser listo para revisión.',
        }),
      ErrorCode.BUSINESS_INVALID_STATE
    )

    expect(tables.deliverables).toHaveLength(1)
    expect(tables.deliverables[0]).toMatchObject({ kind: 'MODEL', status: 'DELIVERED' })
    expect(tables.documentVersions[1].deliveryNote).toBeUndefined()
    expect(tables.notifications).toHaveLength(1)
    expect(sendProductEmail).toHaveBeenCalledTimes(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('rejects a caller without identity before reading the document', async () => {
    const tables = deliverySeed()
    const anonymous = createConvexCtx(tables)

    await expectCode(
      () =>
        runHandler(markDocumentAsDelivery, anonymous, {
          documentId: 'doc_model',
          kind: 'MODEL',
          note: NOTE,
        }),
      ErrorCode.AUTH_NOT_AUTHENTICATED
    )
    expect(tables.deliverables).toHaveLength(0)
    expect(tables.documentVersions[0].deliveryNote).toBeUndefined()
    expect(tables.notifications).toHaveLength(0)
    expect(sendProductEmail).not.toHaveBeenCalled()
  })

  it('is admin-only: the company owner cannot deliver its own room', async () => {
    const tables = deliverySeed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expectCode(
      () =>
        runHandler(markDocumentAsDelivery, ctx, {
          documentId: 'doc_model',
          kind: 'MODEL',
          note: NOTE,
        }),
      ErrorCode.AUTHZ_ADMIN_REQUIRED
    )
    expect(tables.deliverables).toHaveLength(0)
    expect(tables.notifications).toHaveLength(0)
  })

  it('refuses an empty note and a document the client cannot open', async () => {
    const tables = deliverySeed({
      documents: [{ ...usableDocument('doc_model'), lifecycleStatus: 'QUARANTINED' }],
    })
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await expectCode(
      () =>
        runHandler(markDocumentAsDelivery, ctx, {
          documentId: 'doc_model',
          kind: 'MODEL',
          note: '   ',
        }),
      ErrorCode.VALIDATION_FAILED
    )
    await expectCode(
      () =>
        runHandler(markDocumentAsDelivery, ctx, {
          documentId: 'doc_model',
          kind: 'MODEL',
          note: NOTE,
        }),
      ErrorCode.BUSINESS_INVALID_STATE
    )
    expect(tables.deliverables).toHaveLength(0)
    expect(tables.notifications).toHaveLength(0)
  })
})
