// ============================================================================
// SOPORTE — el correo del equipo por un mensaje nuevo del cliente
// ============================================================================
// Contratos: (1) un mensaje del cliente calendariza el aviso y una ráfaga sigue
// siendo UN correo; (2) el correo sale exactamente una vez por tanda de
// mensajes aunque el job se reintente; (3) la respuesta del admin no se avisa a
// sí misma; (4) el texto del cliente no viaja por correo.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface SupportMessageEmailCall {
  recipientProfileId: string
  companyName: string
  messageCount: number
  link: string
}

const sendSupportMessageEmail = vi.fn(
  async (_ctx: unknown, _args: SupportMessageEmailCall): Promise<void> => undefined
)
const sendTeamAlertEmail = vi.fn(async (): Promise<void> => undefined)

vi.mock('../../../convex/email', () => ({
  isProductEmailEnabled: () => true,
  resend: {},
  sendProductEmail: async () => undefined,
  sendServerErrorAlertEmail: async () => undefined,
  sendTeamAlertEmail: () => sendTeamAlertEmail(),
  sendSupportMessageEmail: (ctx: unknown, args: SupportMessageEmailCall) =>
    sendSupportMessageEmail(ctx, args),
}))

import { buildSupportMessageEmail } from '../../../convex/_helpers/teamEmailTemplates'
import {
  SUPPORT_TEAM_EMAIL_DEBOUNCE_MS,
  dispatchSupportMessageEmail,
} from '../../../convex/_support/teamEmail'
import { sendAdminMessage, sendCompanyMessage } from '../../../convex/support'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const NOW = 1_900_000_000_000
const WORKOS_ISSUER = 'https://api.workos.com/'

function row(overrides: Partial<Row> & Pick<Row, '_id'>): Row {
  return { _creationTime: NOW - 10_000, ...overrides }
}

function seededTables(): Tables {
  return {
    users: [
      row({
        _id: 'user_owner',
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'owner@example.com',
        role: 'COMPANY',
      }),
      row({
        _id: 'user_admin_1',
        authProvider: 'workos',
        providerUserId: 'workos_admin_1',
        workosUserId: 'workos_admin_1',
        email: 'fixture-67bb0a48@example.com',
        role: 'ADMIN',
      }),
      row({
        _id: 'user_admin_2',
        authProvider: 'workos',
        providerUserId: 'workos_admin_2',
        workosUserId: 'workos_admin_2',
        email: 'fixture-b2ce6752@example.com',
        role: 'ADMIN',
      }),
    ],
    profiles: [
      row({ _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true }),
      row({ _id: 'profile_admin_1', userId: 'user_admin_1', role: 'ADMIN', isActive: true }),
      row({ _id: 'profile_admin_2', userId: 'user_admin_2', role: 'ADMIN', isActive: true }),
    ],
    companies: [
      row({
        _id: 'company_one',
        ownerId: 'profile_owner',
        name: 'Sample Hydro',
        country: 'PA',
      }),
    ],
    organizationMemberships: [
      row({
        _id: 'membership_owner',
        userId: 'user_owner',
        profileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_company',
        workosOrgId: 'org_company',
        betaRole: 'COMPANY_OWNER',
        profileRole: 'COMPANY',
        status: 'ACTIVE',
        createdAt: NOW - 20_000,
      }),
    ],
    companyOrganizationBindings: [
      row({
        _id: 'binding_company',
        companyId: 'company_one',
        ownerProfileId: 'profile_owner',
        authProvider: 'workos',
        providerOrgId: 'org_company',
        createdAt: NOW - 20_000,
      }),
    ],
    companyAuthorizationControls: [],
    workosDirectoryUsers: [],
    workosDirectories: [],
    workosDirectoryGroupMemberships: [],
    supportThreads: [],
    supportMessages: [],
    rateLimits: [],
    adminAuditLogs: [],
    deliverables: [],
    documents: [],
    intakeSessions: [],
    intakeAssessments: [],
  }
}

type Scheduled = { id: string; delayMs: number; args: { threadId: string } }

/**
 * El scheduler del harness compartido devuelve siempre el mismo id, y lo que
 * este carril promete es justamente que la ráfaga CANCELA el envío anterior y
 * deja uno vivo. Así que acá se le pone un scheduler con ids distintos.
 */
function createCtx(identity: Record<string, unknown>) {
  const ctx = createConvexCtx(seededTables(), { identity })
  // `identity` es la MISMA referencia que lee `getUserIdentity`, así que
  // mutarla cambia de autor sin rehacer las tablas: un hilo largo necesita al
  // cliente y al equipo escribiendo en el mismo hilo.
  const actAs = (next: Record<string, unknown>) => {
    for (const key of Object.keys(identity)) delete identity[key]
    Object.assign(identity, next)
  }
  const scheduled: Scheduled[] = []
  const cancelled: string[] = []
  let jobs = 0

  ctx.scheduler = {
    runAfter: vi.fn(async (delayMs: number, _reference: unknown, args: { threadId: string }) => {
      jobs += 1
      const id = `job_${jobs}`
      scheduled.push({ id, delayMs, args })
      return id
    }),
    runAt: vi.fn(async () => 'job_at'),
    cancel: vi.fn(async (id: string) => {
      cancelled.push(id)
    }),
  } as unknown as typeof ctx.scheduler

  return { ctx, scheduled, cancelled, actAs }
}

const OWNER_IDENTITY = {
  subject: 'workos_owner',
  issuer: WORKOS_ISSUER,
  email: 'owner@example.com',
}
const ADMIN_IDENTITY = {
  subject: 'workos_admin_1',
  issuer: WORKOS_ISSUER,
  email: 'fixture-67bb0a48@example.com',
}

function thread(ctx: ReturnType<typeof createCtx>['ctx']): Row {
  return ctx.tables.supportThreads[0]
}

describe('support — el correo del equipo por un mensaje del cliente', () => {
  beforeEach(() => {
    sendSupportMessageEmail.mockClear()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calendariza un aviso diferido con el ancla de la ventana', async () => {
    const harness = createCtx({
      subject: 'workos_owner',
      issuer: WORKOS_ISSUER,
      email: 'owner@example.com',
    })

    await runHandler(sendCompanyMessage, harness.ctx, {
      companyId: 'company_one',
      body: 'Necesito ayuda con el Data Room.',
    })

    expect(harness.scheduled).toHaveLength(1)
    expect(harness.scheduled[0].delayMs).toBe(SUPPORT_TEAM_EMAIL_DEBOUNCE_MS)
    expect(harness.scheduled[0].args.threadId).toBe(thread(harness.ctx)._id)
    expect(thread(harness.ctx).adminEmailJobId).toBe('job_1')
    expect(thread(harness.ctx).adminEmailPendingSince).toBe(NOW)
    expect(thread(harness.ctx).adminEmailThroughSequence).toBeUndefined()
  })

  it('una ráfaga deja un solo envío vivo y manda un solo correo por ADMIN', async () => {
    const harness = createCtx({
      subject: 'workos_owner',
      issuer: WORKOS_ISSUER,
      email: 'owner@example.com',
    })

    for (let index = 0; index < 3; index += 1) {
      vi.setSystemTime(NOW + index * 5_000)
      await runHandler(sendCompanyMessage, harness.ctx, {
        companyId: 'company_one',
        body: `Mensaje ${index + 1}`,
      })
    }

    // Tres mensajes, tres reprogramaciones, dos cancelaciones: queda un job.
    expect(harness.scheduled).toHaveLength(3)
    expect(harness.cancelled).toEqual(['job_1', 'job_2'])
    expect(thread(harness.ctx).adminEmailJobId).toBe('job_3')
    // El ancla no se mueve con la ráfaga: el techo se mide desde el primero.
    expect(thread(harness.ctx).adminEmailPendingSince).toBe(NOW)

    await dispatchSupportMessageEmail(harness.ctx as never, {
      threadId: thread(harness.ctx)._id as never,
    })

    const recipients = sendSupportMessageEmail.mock.calls.map(([, args]) => args.recipientProfileId)
    expect(recipients.sort()).toEqual(['profile_admin_1', 'profile_admin_2'])
    expect(sendSupportMessageEmail.mock.calls[0][1].messageCount).toBe(3)
    expect(sendSupportMessageEmail.mock.calls[0][1].companyName).toBe('Sample Hydro')
    expect(sendSupportMessageEmail.mock.calls[0][1].link).toBe(
      `/admin/support?thread=${thread(harness.ctx)._id}`
    )
  })

  it('el job reintentado no manda un segundo correo', async () => {
    const harness = createCtx({
      subject: 'workos_owner',
      issuer: WORKOS_ISSUER,
      email: 'owner@example.com',
    })

    await runHandler(sendCompanyMessage, harness.ctx, {
      companyId: 'company_one',
      body: 'Un mensaje.',
    })

    const threadId = thread(harness.ctx)._id as never
    await dispatchSupportMessageEmail(harness.ctx as never, { threadId })
    await dispatchSupportMessageEmail(harness.ctx as never, { threadId })

    expect(sendSupportMessageEmail).toHaveBeenCalledTimes(2)
    expect(thread(harness.ctx).adminEmailThroughSequence).toBe(1)
    expect(thread(harness.ctx).adminEmailDispatchedAt).toBe(NOW)
    // El job vivo se limpia al despachar: nada queda apuntando a un envío hecho.
    expect(thread(harness.ctx).adminEmailJobId).toBeUndefined()
    expect(thread(harness.ctx).adminEmailPendingSince).toBeUndefined()
  })

  it('la respuesta del admin no calendariza ni se avisa a sí misma', async () => {
    const harness = createCtx({
      subject: 'workos_admin_1',
      issuer: WORKOS_ISSUER,
      email: 'fixture-67bb0a48@example.com',
    })

    await runHandler(sendAdminMessage, harness.ctx, {
      companyId: 'company_one',
      body: '¿Puedes compartir el detalle faltante?',
    })

    expect(harness.scheduled).toHaveLength(0)

    // Y si un job viejo despierta sobre un hilo donde solo respondió el equipo,
    // se cierra sin mandar nada.
    await dispatchSupportMessageEmail(harness.ctx as never, {
      threadId: thread(harness.ctx)._id as never,
    })
    expect(sendSupportMessageEmail).not.toHaveBeenCalled()
    expect(thread(harness.ctx).adminEmailThroughSequence).toBe(1)
  })

  it('avisa aunque el equipo haya escrito más mensajes de los que cabe el escaneo', async () => {
    const harness = createCtx({ ...OWNER_IDENTITY })

    // Primer mensaje del cliente, avisado: el marcador queda en 1.
    await runHandler(sendCompanyMessage, harness.ctx, {
      companyId: 'company_one',
      body: 'Primera pregunta.',
    })
    await dispatchSupportMessageEmail(harness.ctx as never, {
      threadId: thread(harness.ctx)._id as never,
    })
    sendSupportMessageEmail.mockClear()

    // El equipo responde 30 veces mientras el cliente calla. Ninguna calendariza
    // nada, pero todas quedan por delante del marcador.
    harness.actAs({ ...ADMIN_IDENTITY })
    for (let index = 0; index < 30; index += 1) {
      await runHandler(sendAdminMessage, harness.ctx, {
        companyId: 'company_one',
        body: `Actualización ${index + 1}`,
      })
    }

    // El cliente vuelve a escribir: ESE mensaje tiene que producir correo.
    harness.actAs({ ...OWNER_IDENTITY })
    await runHandler(sendCompanyMessage, harness.ctx, {
      companyId: 'company_one',
      body: 'Vuelvo con una duda.',
    })
    await dispatchSupportMessageEmail(harness.ctx as never, {
      threadId: thread(harness.ctx)._id as never,
    })

    expect(sendSupportMessageEmail).toHaveBeenCalledTimes(2)
    expect(sendSupportMessageEmail.mock.calls[0][1].messageCount).toBe(1)
  })
})

describe('plantilla del aviso de soporte', () => {
  it('nombra la empresa y el enlace, y nunca el texto del cliente', () => {
    const email = buildSupportMessageEmail({
      companyName: 'Sample Hydro',
      messageCount: 2,
      url: 'https://www.sherlock.capital/es/admin/support?thread=thread_1',
    })

    expect(email.subject).toContain('Sample Hydro')
    expect(email.html).toContain('https://www.sherlock.capital/es/admin/support?thread=thread_1')
    expect(email.text).toContain('2 mensajes nuevos')
    for (const part of [email.subject, email.html, email.text]) {
      expect(part).not.toContain('Necesito ayuda con el Data Room')
    }
  })

  it('escapa el nombre de la empresa en el cuerpo HTML', () => {
    const email = buildSupportMessageEmail({
      companyName: '<script>alert("x")</script>',
      messageCount: 1,
      url: 'https://www.sherlock.capital/es/admin/support?thread=thread_1',
    })

    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
  })
})
