// ============================================================================
// COMPANY CHECKLIST — derivación, authz y sello de activación artesanal
// ============================================================================
// Contratos: el alta automática no confirma el nombre; un claim con nombre
// declarado y el rename de la sala sí; QUARANTINED no cuenta; una empresa
// ajena no lee; solo ADMIN marca ítems manuales y activa, con audit log.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createIntakeClaimProof } from './intake-claim-proof-test-helper'
import {
  ensureCompanyWorkspace,
  updateCompany,
  updateContactPhone,
} from '../../../convex/companies'
import {
  getCompanyChecklist,
  setActivation,
  setChecklistItem,
  type CompanyChecklistView,
} from '../../../convex/companyChecklist'
import { validate } from 'convex-helpers/validators'

import { DELIVERABLE_KINDS, deliverableKindValidator } from '../../../convex/_deliverables/model'
import { request } from '../../../convex/deliverables'
import { ErrorCode } from '../../../convex/_helpers/errors'
import { hashIntakeSessionToken } from '../../../convex/_intake/crypto'
import { claimToAuthenticatedCompany } from '../../../convex/intake'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const NOW = Date.UTC(2026, 8, 1, 20, 26, 0)

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
const ADMIN_TWO_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_admin_2',
  email: 'fixture-8222fd41@example.com',
}
const FIRST_LOGIN_IDENTITY = {
  subject: 'user_workos_bootstrap',
  issuer: 'https://api.workos.com/user_management/client_test',
  email: 'fixture-9dcfd121@example.com',
  name: 'Fundadora Cero',
}

const INTAKE_SECRET = 'intake-claim-secret-for-tests-123456789012345' // gitleaks:allow -- deterministic test fixture, not a provider credential
const INTAKE_AUDIENCE = 'sherlock-test:intake-claim'
const SESSION_TOKEN = 's'.repeat(43)
const PDF_HASH = 'a'.repeat(64)

function row(overrides: Partial<Row> & Pick<Row, '_id'>): Row {
  return { _creationTime: 1, ...overrides }
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
        _id: 'user_admin_2',
        authProvider: 'workos',
        providerUserId: 'workos_admin_2',
        workosUserId: 'workos_admin_2',
        email: 'fixture-8222fd41@example.com',
      },
    ],
    profiles: [
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true },
      { _id: 'profile_outsider', userId: 'user_outsider', role: 'COMPANY', isActive: true },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
      { _id: 'profile_admin_2', userId: 'user_admin_2', role: 'ADMIN', isActive: true },
    ],
    companies: [
      { _id: 'company_1', ownerId: 'profile_owner', name: 'Mi empresa' },
      { _id: 'company_2', ownerId: 'profile_outsider', name: 'Otra Co' },
    ],
    companyOrganizationBindings: [],
    companyAuthorizationControls: [],
    organizationMemberships: [],
    documents: [],
    documentVersions: [],
    deliverables: [],
    companyChecklist: [],
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

function checklistOf(view: CompanyChecklistView) {
  return view
}

describe('company checklist', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('persists the owner contact phone, refreshes the checklist and records an audit without the number', async () => {
    const tables = seed({ activityLogs: [] })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const before: CompanyChecklistView = await runHandler(getCompanyChecklist, ctx, {
      companyId: 'company_1',
    })
    expect(before.items.phone.done).toBe(false)
    await runHandler(updateContactPhone, ctx, { companyId: 'company_1', phone: ' +507 6000-1234 ' })
    expect(tables.profiles.find((profile) => profile._id === 'profile_owner')?.phone).toBe(
      '+507 6000-1234'
    )
    const after: CompanyChecklistView = await runHandler(getCompanyChecklist, ctx, {
      companyId: 'company_1',
    })
    expect(after.items.phone.done).toBe(true)
    expect(after.completedCount).toBe(before.completedCount + 1)
    expect(tables.activityLogs).toEqual([
      expect.objectContaining({
        action: 'COMPANY_CONTACT_PHONE_UPDATED',
        userId: 'profile_owner',
        entityId: 'company_1',
      }),
    ])
    expect(JSON.stringify(tables.activityLogs)).not.toContain('6000')
  })

  it.each(['', 'abc', '123456', '1234567890123456', '+507 6000<script>', '1'.repeat(100)])(
    'rejects malformed contact phone %j without writing',
    async (phone) => {
      const tables = seed()
      const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
      await expect(
        runHandler(updateContactPhone, ctx, { companyId: 'company_1', phone })
      ).rejects.toThrow()
      expect(
        tables.profiles.find((profile) => profile._id === 'profile_owner')?.phone
      ).toBeUndefined()
    }
  )

  it.each([undefined, OUTSIDER_IDENTITY, ADMIN_IDENTITY])(
    'rejects contact phone writes outside the actual company owner session',
    async (identity) => {
      const tables = seed()
      const ctx = createConvexCtx(tables, { identity })
      await expect(
        runHandler(updateContactPhone, ctx, { companyId: 'company_1', phone: '+507 6000-1234' })
      ).rejects.toThrow()
      expect(
        tables.profiles.find((profile) => profile._id === 'profile_owner')?.phone
      ).toBeUndefined()
    }
  )

  it('does not reveal company existence to another company owner', async () => {
    const ctx = createConvexCtx(seed(), { identity: OUTSIDER_IDENTITY })
    await expectCode(
      () =>
        runHandler(updateContactPhone, ctx, {
          companyId: 'company_1',
          phone: '+507 6000-1234',
        }),
      ErrorCode.AUTHZ_UNAUTHORIZED
    )
    await expectCode(
      () =>
        runHandler(updateContactPhone, ctx, {
          companyId: 'company_missing',
          phone: '+507 6000-1234',
        }),
      ErrorCode.AUTHZ_UNAUTHORIZED
    )
  })

  it('rejects anonymous readers without revealing company existence to another owner', async () => {
    const tables = seed()
    const anonymous = createConvexCtx(tables)
    const outsider = createConvexCtx(tables, { identity: OUTSIDER_IDENTITY })

    await expectCode(
      () => runHandler(getCompanyChecklist, anonymous, { companyId: 'company_1' }),
      ErrorCode.AUTH_NOT_AUTHENTICATED
    )
    await expectCode(
      () => runHandler(getCompanyChecklist, outsider, { companyId: 'company_1' }),
      ErrorCode.AUTHZ_UNAUTHORIZED
    )
    await expectCode(
      () => runHandler(getCompanyChecklist, outsider, { companyId: 'company_missing' }),
      ErrorCode.AUTHZ_UNAUTHORIZED
    )
  })

  it('returns seven empty items and eight pending stages with no row', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    const view = checklistOf(await runHandler(getCompanyChecklist, ctx, { companyId: 'company_1' }))

    expect(tables.companyChecklist).toHaveLength(0)
    expect(view.completedCount).toBe(0)
    expect(view.activation.active).toBe(false)
    expect(view.items.nameConfirmed.done).toBe(false)
    expect(view.items.phone.done).toBe(false)
    expect(view.items.financials.done).toBe(false)
    expect(view.items.legal.done).toBe(false)
    expect(view.items.corporate.done).toBe(false)
    expect(view.items.financialsDepth.done).toBe(false)
    expect(view.items.kickoffCall.done).toBe(false)
    expect(view.stages.map((stage) => stage.key)).toEqual([
      'MODEL_V1',
      'MODEL_V2',
      'TEASER',
      'CIM',
      'MGMT_PRESENTATION',
      'DECKS',
      'QA',
      'IRL',
    ])
    expect(view.stages.every((stage) => stage.status === 'PENDING')).toBe(true)
  })

  it('does not confirm the name on automatic workspace provisioning', async () => {
    const harness = createConvexCtx({}, { identity: FIRST_LOGIN_IDENTITY })
    const result = await runHandler<
      Record<string, never>,
      { created: boolean; company: { _id: string } | null }
    >(ensureCompanyWorkspace, harness, {})

    expect(result.created).toBe(true)
    expect(result.company).toBeTruthy()
    expect(harness.tables.companyChecklist ?? []).toHaveLength(0)

    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      harness,
      { companyId: result.company!._id }
    )
    expect(view.items.nameConfirmed.done).toBe(false)
  })

  it('confirms the name from the room rename and not from other profile fields', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await runHandler(updateCompany, ctx, { companyId: 'company_1', country: 'PA' })
    expect(tables.companyChecklist).toHaveLength(0)

    await runHandler(updateCompany, ctx, { companyId: 'company_1', name: 'Acme Panamá' })
    expect(tables.companyChecklist).toHaveLength(1)
    expect(tables.companyChecklist[0]).toMatchObject({
      companyId: 'company_1',
      nameConfirmedSource: 'ROOM_RENAME',
    })
    expect(typeof tables.companyChecklist[0].nameConfirmedAt).toBe('number')

    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )
    expect(view.items.nameConfirmed.done).toBe(true)
    expect(view.items.nameConfirmed.source).toBe('ROOM_RENAME')
  })

  it('does not confirm the name when the form resubmits the stored name unchanged', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await runHandler(updateCompany, ctx, {
      companyId: 'company_1',
      name: '  Mi empresa  ',
      website: 'https://mi.empresa',
    })

    expect(tables.companyChecklist).toHaveLength(0)

    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )
    expect(view.items.nameConfirmed.done).toBe(false)
  })

  it('confirms the stored name only when the caller sends the explicit flag', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await runHandler(updateCompany, ctx, {
      companyId: 'company_1',
      name: 'Mi empresa',
      confirmName: true,
    })

    expect(tables.companyChecklist).toHaveLength(1)
    expect(tables.companyChecklist[0]).toMatchObject({
      companyId: 'company_1',
      nameConfirmedSource: 'ROOM_RENAME',
    })
    // El flag es una señal de intención, no un campo de la empresa.
    expect(tables.companies[0]).not.toHaveProperty('confirmName')
  })

  it('counts inherited financials folders and ignores quarantined documents', async () => {
    const tables = seed({
      documents: [
        {
          _id: 'doc_fin',
          companyId: 'company_1',
          name: 'eeff.xlsx',
          folder: 'financials',
          lifecycleStatus: 'ACTIVE',
        },
        {
          _id: 'doc_quarantine',
          companyId: 'company_1',
          name: 'virus.pdf',
          folder: 'legal',
          lifecycleStatus: 'QUARANTINED',
        },
        {
          _id: 'doc_ops',
          companyId: 'company_1',
          name: 'planta.pdf',
          folder: 'room_operations',
          lifecycleStatus: 'ACTIVE',
        },
        {
          _id: 'doc_other_company',
          companyId: 'company_2',
          name: 'cap.xlsx',
          folder: 'cap_table',
          lifecycleStatus: 'ACTIVE',
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )

    expect(view.items.financials).toMatchObject({ done: true, count: 1 })
    expect(view.items.legal).toMatchObject({ done: false, count: 0 })
    expect(view.items.corporate).toMatchObject({ done: false, count: 0 })
  })

  it('leaves the phone item pending when the owner has no number', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )
    expect(view.items.phone.done).toBe(false)
  })

  it('treats a non-empty owner phone as done', async () => {
    const tables = seed({
      profiles: [
        {
          _id: 'profile_owner',
          userId: 'user_owner',
          role: 'COMPANY',
          isActive: true,
          phone: '+507 6000-0000',
        },
        { _id: 'profile_outsider', userId: 'user_outsider', role: 'COMPANY', isActive: true },
        { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )
    expect(view.items.phone.done).toBe(true)
  })

  it('rejects company callers on the admin mutations', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })

    await expectCode(
      () =>
        runHandler(setChecklistItem, ctx, {
          companyId: 'company_1',
          item: 'kickoffCall',
          done: true,
        }),
      ErrorCode.AUTHZ_ADMIN_REQUIRED
    )
    await expectCode(
      () => runHandler(setActivation, ctx, { companyId: 'company_1', active: true }),
      ErrorCode.AUTHZ_ADMIN_REQUIRED
    )
    expect(tables.companyChecklist).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('lets an admin mark manuals and activate below 100% with an audit row', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const marked = await runHandler<
      { companyId: string; item: 'kickoffCall'; done: boolean; note?: string },
      CompanyChecklistView
    >(setChecklistItem, ctx, {
      companyId: 'company_1',
      item: 'kickoffCall',
      done: true,
      note: 'Llamada el martes',
    })
    expect(marked.items.kickoffCall).toMatchObject({
      done: true,
      by: 'profile_admin',
      note: 'Llamada el martes',
    })
    expect(marked.completedCount).toBe(1)
    expect(tables.adminAuditLogs).toHaveLength(1)
    expect(tables.adminAuditLogs[0]).toMatchObject({
      action: 'CHECKLIST_ITEM_SET',
      targetType: 'COMPANY',
      targetId: 'company_1',
      adminProfileId: 'profile_admin',
    })

    const activated = await runHandler<
      { companyId: string; active: boolean; note?: string },
      CompanyChecklistView
    >(setActivation, ctx, {
      companyId: 'company_1',
      active: true,
      note: 'Arrancamos con lo que hay',
    })
    expect(activated.activation).toMatchObject({
      active: true,
      by: 'profile_admin',
      note: 'Arrancamos con lo que hay',
    })
    expect(activated.completedCount).toBe(1)
    expect(tables.adminAuditLogs).toHaveLength(2)
    expect(tables.adminAuditLogs[1]).toMatchObject({
      action: 'COMPANY_ROOM_ACTIVATION',
      targetId: 'company_1',
    })
  })

  it('is idempotent on activation: the repeat neither writes, audits, nor moves the activator', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const first = await runHandler<
      { companyId: string; active: boolean; note?: string },
      CompanyChecklistView & { changed: boolean }
    >(setActivation, ctx, {
      companyId: 'company_1',
      active: true,
      note: 'Arrancamos con lo que hay',
    })
    expect(first.changed).toBe(true)
    const sealedAt = tables.companyChecklist[0].activatedAt

    const otherAdmin = createConvexCtx(tables, { identity: ADMIN_TWO_IDENTITY })
    const repeat = await runHandler<
      { companyId: string; active: boolean; note?: string },
      CompanyChecklistView & { changed: boolean }
    >(setActivation, otherAdmin, {
      companyId: 'company_1',
      active: true,
      note: 'Otra nota',
    })

    expect(repeat.changed).toBe(false)
    expect(repeat.activation).toMatchObject({
      active: true,
      by: 'profile_admin',
      note: 'Arrancamos con lo que hay',
    })
    expect(tables.companyChecklist[0]).toMatchObject({
      activatedBy: 'profile_admin',
      activatedAt: sealedAt,
      activationNote: 'Arrancamos con lo que hay',
    })
    expect(tables.adminAuditLogs).toHaveLength(1)
  })

  it('does not create a checklist row when deactivating a room that was never active', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    const result = await runHandler<
      { companyId: string; active: boolean },
      CompanyChecklistView & { changed: boolean }
    >(setActivation, ctx, { companyId: 'company_1', active: false })

    expect(result.changed).toBe(false)
    expect(result.activation.active).toBe(false)
    expect(tables.companyChecklist).toHaveLength(0)
    expect(tables.adminAuditLogs).toHaveLength(0)
  })

  it('hides the internal notes and the admin profile ids from a company reader', async () => {
    const tables = seed()
    const adminCtx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await runHandler(setChecklistItem, adminCtx, {
      companyId: 'company_1',
      item: 'kickoffCall',
      done: true,
      note: 'El CFO no suelta los estados de 2024',
    })
    await runHandler(setActivation, adminCtx, {
      companyId: 'company_1',
      active: true,
      note: 'Arrancamos aunque falte legal',
    })

    const ownerCtx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const asCompany = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ownerCtx,
      { companyId: 'company_1' }
    )

    // El cliente sigue viendo su progreso: estado y fechas.
    expect(asCompany.items.kickoffCall.done).toBe(true)
    expect(typeof asCompany.items.kickoffCall.at).toBe('number')
    expect(asCompany.activation.active).toBe(true)
    expect(typeof asCompany.activation.at).toBe('number')

    expect(asCompany.items.kickoffCall).not.toHaveProperty('note')
    expect(asCompany.items.kickoffCall).not.toHaveProperty('by')
    expect(asCompany.activation).not.toHaveProperty('note')
    expect(asCompany.activation).not.toHaveProperty('by')
    const serialized = JSON.stringify(asCompany)
    expect(serialized).not.toContain('profile_admin')
    expect(serialized).not.toContain('El CFO no suelta')
    expect(serialized).not.toContain('Arrancamos aunque falte legal')

    // El equipo sí ve la operación completa.
    const asAdmin = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      adminCtx,
      { companyId: 'company_1' }
    )
    expect(asAdmin.items.kickoffCall).toMatchObject({
      by: 'profile_admin',
      note: 'El CFO no suelta los estados de 2024',
    })
    expect(asAdmin.activation).toMatchObject({
      by: 'profile_admin',
      note: 'Arrancamos aunque falte legal',
    })
  })

  // `runHandler` invoca el handler crudo y SE SALTA el validator de args: sin
  // el test de abajo, borrar `v.literal('QA')` de `deliverableKindValidator`
  // dejaría este verde y rompería la mutation en producción.
  it('declares QA and IRL in the args validator that Convex applies at the boundary', () => {
    const exported = JSON.parse(
      (request as unknown as { exportArgs: () => string }).exportArgs()
    ) as {
      value: {
        kind: { fieldType: { type: string; value: Array<{ type: string; value: unknown }> } }
      }
    }
    const kindArg = exported.value.kind.fieldType

    expect(kindArg.type).toBe('union')
    expect(kindArg.value.map((member) => member.value)).toEqual([...DELIVERABLE_KINDS])
    expect(validate(deliverableKindValidator, 'QA')).toBe(true)
    expect(validate(deliverableKindValidator, 'IRL')).toBe(true)
    expect(validate(deliverableKindValidator, 'ROADSHOW')).toBe(false)
  })

  it('accepts QA and IRL as deliverable kinds and surfaces them on the rail', async () => {
    const tables = seed()
    const ctx = createConvexCtx(tables, { identity: ADMIN_IDENTITY })

    await runHandler(request, ctx, { kind: 'QA', companyId: 'company_1' })
    await runHandler(request, ctx, { kind: 'IRL', companyId: 'company_1' })

    expect(tables.deliverables.map((row) => row.kind)).toEqual(['QA', 'IRL'])

    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )
    expect(view.stages.find((stage) => stage.key === 'QA')?.status).toBe('REQUESTED')
    expect(view.stages.find((stage) => stage.key === 'IRL')?.status).toBe('REQUESTED')
  })

  it('splits the decks stage into debt and equity, with the blocking status winning', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'deliverable_debt',
          companyId: 'company_1',
          kind: 'DEBT_DECK',
          status: 'NEEDS_INPUT',
          updatedAt: NOW - 1_000,
        },
        {
          _id: 'deliverable_equity',
          companyId: 'company_1',
          kind: 'EQUITY_DECK',
          status: 'DELIVERED',
          updatedAt: NOW,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )

    const decks = view.stages.find((stage) => stage.key === 'DECKS')
    expect(decks?.status).toBe('NEEDS_INPUT')
    expect(decks?.updatedAt).toBe(NOW)
    expect(decks?.items).toEqual([
      { kind: 'DEBT_DECK', status: 'NEEDS_INPUT' },
      { kind: 'EQUITY_DECK', status: 'DELIVERED' },
    ])
  })

  it('lists a deck with no slot as pending and lets the open deck set the stage', async () => {
    const tables = seed({
      deliverables: [
        {
          _id: 'deliverable_equity',
          companyId: 'company_1',
          kind: 'EQUITY_DECK',
          status: 'IN_PROGRESS',
          updatedAt: NOW,
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )

    const decks = view.stages.find((stage) => stage.key === 'DECKS')
    expect(decks?.status).toBe('IN_PROGRESS')
    expect(decks?.items).toEqual([
      { kind: 'DEBT_DECK', status: 'PENDING' },
      { kind: 'EQUITY_DECK', status: 'IN_PROGRESS' },
    ])
  })

  it('keeps model v2 pending until a rendition reaches version 2', async () => {
    const tables = seed({
      documents: [
        {
          _id: 'doc_model',
          companyId: 'company_1',
          name: 'modelo.xlsx',
          folder: 'room_financial',
          lifecycleStatus: 'ACTIVE',
          currentVersionNumber: 1,
          currentVersionId: 'version_model',
        },
      ],
      documentVersions: [
        {
          _id: 'version_model',
          documentId: 'doc_model',
          companyId: 'company_1',
          versionNumber: 1,
          deliveryLabel: 'v1',
        },
      ],
      deliverables: [
        {
          _id: 'deliverable_model',
          companyId: 'company_1',
          kind: 'MODEL',
          status: 'DELIVERED',
          updatedAt: NOW,
          renditions: [{ format: 'XLSX', documentId: 'doc_model' }],
        },
      ],
    })
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    const view = await runHandler<{ companyId: string }, CompanyChecklistView>(
      getCompanyChecklist,
      ctx,
      { companyId: 'company_1' }
    )

    expect(view.stages.find((stage) => stage.key === 'MODEL_V1')?.status).toBe('DELIVERED')
    expect(view.stages.find((stage) => stage.key === 'MODEL_V2')?.status).toBe('PENDING')
  })
})

describe('company checklist — intake claim name', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', INTAKE_SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', INTAKE_AUDIENCE)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  async function claimTables(identityName?: string): Promise<Tables> {
    const sessionId = 'intake_session_1'
    const documents: Row[] = [
      row({
        _id: 'intake_document_pdf',
        intakeSessionId: sessionId,
        uploadIntentId: 'intake_intent_pdf',
        displayName: 'Estados financieros.pdf',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 128,
        sha256: PDF_HASH,
        storageId: 'storage_pdf',
        storageState: 'STAGED_INTAKE',
        inspectionStatus: 'CLEAN',
        claimable: true,
        signatureKind: 'PDF',
        scannerEngine: 'scanner',
        scannerScanId: 'scan-pdf',
        scannedAt: 100,
        createdAt: 100,
      }),
    ]
    return {
      users: [
        row({
          _id: 'user_owner',
          authProvider: 'workos',
          providerUserId: 'workos_owner',
          workosUserId: 'workos_owner',
          email: 'fixture-adfd7e27@example.com',
          role: 'COMPANY',
        }),
      ],
      profiles: [
        row({
          _id: 'profile_owner',
          userId: 'user_owner',
          role: 'COMPANY',
          roleConfirmed: true,
          isActive: true,
        }),
      ],
      companies: [row({ _id: 'company_1', ownerId: 'profile_owner', name: 'Mi empresa' })],
      companyOrganizationBindings: [],
      companyAuthorizationControls: [],
      organizationMemberships: [],
      intakeSessions: [
        row({
          _id: sessionId,
          sessionTokenHash: await hashIntakeSessionToken(SESSION_TOKEN),
          anonymousKeyHash: 'd'.repeat(64),
          audience: INTAKE_AUDIENCE,
          status: 'ACTIVE',
          claimStatus: 'UNCLAIMED',
          ...(identityName === undefined
            ? {}
            : {
                identityEvidence: {
                  kind: 'NAME',
                  name: identityName,
                  capturedAt: 100,
                },
              }),
          createdAt: NOW - 1_000,
          accessExpiresAt: NOW + 60_000,
          absoluteExpiresAt: NOW + 120_000,
          deletionProofExpiresAt: NOW + 180_000,
          rotationCount: 0,
          documentCount: documents.length,
          totalStagedBytes: 128,
        }),
      ],
      intakeDocuments: documents,
      intakeUploadIntents: [],
      intakeAssessments: [],
      intakeEvents: [],
      intakeProofNonces: [],
      documents: [],
      documentVersions: [],
      vdrUploadIntents: [],
      assetUploadIntents: [],
      companyChecklist: [],
      teamAlerts: [],
      notifications: [],
    }
  }

  function claimCtx(tables: Tables) {
    const ctx = createConvexCtx(tables, { identity: OWNER_IDENTITY })
    Object.assign(ctx.db, {
      system: {
        get: vi.fn(async (id: string) =>
          id === 'storage_pdf'
            ? row({
                _id: 'storage_pdf',
                size: 128,
                sha256: PDF_HASH,
                contentType: 'application/pdf',
              })
            : null
        ),
      },
    })
    Object.assign(ctx, { storage: { delete: vi.fn(), get: vi.fn() } })
    return ctx
  }

  function claimArgs() {
    return {
      sessionToken: SESSION_TOKEN,
      workosSubject: OWNER_IDENTITY.subject,
      ...createIntakeClaimProof({
        sessionToken: SESSION_TOKEN,
        workosSubject: OWNER_IDENTITY.subject,
      }),
    }
  }

  it('confirms the name when the claim carries a declared name, even if it matches', async () => {
    const tables = await claimTables('Mi empresa')
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)
    expect(claimed).toMatchObject({ status: 'SUCCEEDED', companyId: 'company_1' })
    expect(tables.companyChecklist).toHaveLength(1)
    expect(tables.companyChecklist[0]).toMatchObject({
      companyId: 'company_1',
      nameConfirmedSource: 'INTAKE_CLAIM',
    })
  })

  it('does not confirm the name when the claim has no declared name', async () => {
    const tables = await claimTables()
    const ctx = claimCtx(tables)
    const args = claimArgs()

    await runHandler(claimToAuthenticatedCompany, ctx, args)
    const claimed = await runHandler(claimToAuthenticatedCompany, ctx, args)
    expect(claimed).toMatchObject({ status: 'SUCCEEDED' })
    expect(tables.companyChecklist ?? []).toHaveLength(0)
  })
})
