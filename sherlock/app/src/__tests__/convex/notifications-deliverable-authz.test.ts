// La campanita de entrega guarda la nota del equipo y el nombre del
// documento. getNotifications solo miraba el perfil. Un dueño revocado
// con el perfil activo no debe recibir esas filas. Las formas autorizadas
// de hoy sí.

import { describe, expect, it } from 'vitest'

import { getNotifications, getUnreadCount } from '../../../convex/notifications'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const OWNER_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_owner',
  email: 'owner@example.com',
}

function membership(status: 'ACTIVE' | 'INACTIVE'): Row {
  return {
    _id: 'membership_owner',
    _creationTime: 4,
    userId: 'user_owner',
    profileId: 'profile_owner',
    authProvider: 'workos',
    providerOrgId: 'org_owner',
    workosOrgId: 'org_owner',
    betaRole: 'COMPANY_OWNER',
    profileRole: 'COMPANY',
    status,
    createdAt: 4,
  }
}

function inbox(memberships: Row[] = []): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'owner@example.com',
        role: 'COMPANY',
      },
    ],
    profiles: [
      {
        _id: 'profile_owner',
        _creationTime: 2,
        userId: 'user_owner',
        role: 'COMPANY',
        isActive: true,
      },
    ],
    companies: [
      {
        _id: 'company_owner',
        _creationTime: 3,
        ownerId: 'profile_owner',
        name: 'Emisora',
      },
    ],
    organizationMemberships: memberships,
    companyOrganizationBindings: [],
    companyAuthorizationControls: [],
    organizationMembershipTombstones: [],
    notifications: [
      {
        _id: 'notice_delivery',
        _creationTime: 20,
        userId: 'profile_owner',
        type: 'document_shared',
        title: 'Nuevo en tu sala: Estados 2024.pdf',
        message: 'Nota del equipo: revisar el inventario.',
        isRead: false,
      },
      {
        _id: 'notice_system',
        _creationTime: 10,
        userId: 'profile_owner',
        type: 'system',
        title: 'Revisión de la sala',
        message: 'Tu sala tiene una revisión pendiente.',
        isRead: false,
      },
    ],
  }
}

async function readInbox(rows: Tables) {
  const ctx = createConvexCtx(rows, { identity: OWNER_IDENTITY })
  const notices = await runHandler<{ userId: string }, Array<{ _id: string; type: string }>>(
    getNotifications,
    ctx,
    { userId: 'profile_owner' }
  )
  const unread = await runHandler<{ userId: string }, number>(getUnreadCount, ctx, {
    userId: 'profile_owner',
  })
  return { notices, unread }
}

describe('notifications deliverable rows', () => {
  it('keeps deliverable rows for an owner with no membership history', async () => {
    const { notices, unread } = await readInbox(inbox())

    expect(notices.map((row) => row._id)).toEqual(['notice_delivery', 'notice_system'])
    expect(unread).toBe(2)
  })

  it('keeps deliverable rows for an owner with one active owner membership', async () => {
    const { notices, unread } = await readInbox(inbox([membership('ACTIVE')]))

    expect(notices.map((row) => row._id)).toContain('notice_delivery')
    expect(unread).toBe(2)
  })

  it('drops deliverable rows when the owner membership is revoked', async () => {
    const { notices, unread } = await readInbox(inbox([membership('INACTIVE')]))

    expect(notices.map((row) => row._id)).toEqual(['notice_system'])
    expect(JSON.stringify(notices)).not.toContain('Nota del equipo')
    expect(JSON.stringify(notices)).not.toContain('Estados 2024.pdf')
    expect(unread).toBe(1)
  })

  it('keeps an admin inbox that is not tied to a company', async () => {
    const rows = inbox()
    rows.users = [
      {
        _id: 'user_admin',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: 'workos_admin',
        workosUserId: 'workos_admin',
        email: 'admin@example.com',
        role: 'ADMIN',
      },
    ]
    rows.profiles = [
      {
        _id: 'profile_admin',
        _creationTime: 2,
        userId: 'user_admin',
        role: 'ADMIN',
        isActive: true,
      },
    ]
    rows.companies = []
    rows.notifications = [
      {
        _id: 'notice_admin',
        _creationTime: 20,
        userId: 'profile_admin',
        type: 'document_shared',
        title: 'Aviso interno',
        message: 'Sin empresa.',
        isRead: false,
      },
    ]
    const ctx = createConvexCtx(rows, {
      identity: {
        issuer: 'https://api.workos.com/',
        subject: 'workos_admin',
        email: 'admin@example.com',
      },
    })

    const notices = await runHandler<{ userId: string }, Array<{ _id: string }>>(
      getNotifications,
      ctx,
      { userId: 'profile_admin' }
    )

    expect(notices.map((row) => row._id)).toEqual(['notice_admin'])
  })
})
