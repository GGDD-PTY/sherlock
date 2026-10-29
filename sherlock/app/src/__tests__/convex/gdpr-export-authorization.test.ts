// El export del titular incluía la empresa solo porque ownerId coincidía.
// Un dueño revocado con el perfil activo no debe llevarse nombre, razón
// social ni descripción. Las tres formas que hoy están autorizadas sí.

import { describe, expect, it } from 'vitest'

import { exportUserData } from '../../../convex/gdpr'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const OWNER_IDENTITY = {
  issuer: 'https://api.workos.com/',
  subject: 'workos_owner',
  email: 'owner@example.com',
}

function ownerMembership(status: 'ACTIVE' | 'INACTIVE'): Row {
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

function tables(memberships: Row[] = []): Tables {
  return {
    users: [
      {
        _id: 'user_owner',
        _creationTime: 1,
        authProvider: 'workos',
        providerUserId: 'workos_owner',
        workosUserId: 'workos_owner',
        email: 'owner@example.com',
        name: 'Dueño',
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
        fullName: 'Dueño',
      },
    ],
    companies: [
      {
        _id: 'company_owner',
        _creationTime: 3,
        ownerId: 'profile_owner',
        name: 'Emisora',
        legalName: 'Emisora, S.A.',
        country: 'PA',
        industry: 'Alimentos',
        description: 'Descripción confidencial',
      },
    ],
    organizationMemberships: memberships,
    companyOrganizationBindings: [],
    companyAuthorizationControls: [],
    organizationMembershipTombstones: [],
    notifications: [],
    consents: [],
  }
}

function deliverableNotices(): Row[] {
  return [
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
  ]
}

function tablesWithNotices(memberships: Row[] = []): Tables {
  return { ...tables(memberships), notifications: deliverableNotices() }
}

type ExportedNotice = { type: string; title: string; message: string }

async function exportAsOwner(rows: Tables) {
  const ctx = createConvexCtx(rows, { identity: OWNER_IDENTITY })
  return runHandler<
    { profileId: string },
    {
      profile: { id: string }
      company: { name: string; description?: string } | null
      notifications: ExportedNotice[]
    }
  >(exportUserData, ctx, { profileId: 'profile_owner' })
}

describe('gdpr.exportUserData company block', () => {
  it('lets an admin export the company block', async () => {
    const rows = tables()
    rows.users.push({
      _id: 'user_admin',
      _creationTime: 5,
      authProvider: 'workos',
      providerUserId: 'workos_admin',
      workosUserId: 'workos_admin',
      email: 'admin@example.com',
      role: 'ADMIN',
    })
    rows.profiles.push({
      _id: 'profile_admin',
      _creationTime: 6,
      userId: 'user_admin',
      role: 'ADMIN',
      isActive: true,
    })
    const ctx = createConvexCtx(rows, {
      identity: {
        issuer: 'https://api.workos.com/',
        subject: 'workos_admin',
        email: 'admin@example.com',
      },
    })

    const exported = await runHandler<
      { profileId: string },
      { company: { name: string } | null }
    >(exportUserData, ctx, { profileId: 'profile_owner' })

    expect(exported.company).toMatchObject({ name: 'Emisora' })
  })

  it('includes the company for an owner with no membership history', async () => {
    const exported = await exportAsOwner(tables())

    expect(exported.company).toMatchObject({
      name: 'Emisora',
      legalName: 'Emisora, S.A.',
      description: 'Descripción confidencial',
    })
  })

  it('includes the company for an owner with one active owner membership', async () => {
    const exported = await exportAsOwner(tables([ownerMembership('ACTIVE')]))

    expect(exported.company).toMatchObject({ name: 'Emisora' })
  })

  it('omits the company when the owner membership is revoked and the profile stays active', async () => {
    const exported = await exportAsOwner(tables([ownerMembership('INACTIVE')]))

    expect(exported.profile.id).toBe('profile_owner')
    expect(exported.company).toBeNull()
    expect(JSON.stringify(exported)).not.toContain('Descripción confidencial')
    expect(JSON.stringify(exported)).not.toContain('Emisora, S.A.')
  })
})

describe('gdpr.exportUserData deliverable notifications', () => {
  it('drops document_shared rows when the owner membership is revoked', async () => {
    const exported = await exportAsOwner(tablesWithNotices([ownerMembership('INACTIVE')]))

    expect(exported.notifications.map((row) => row.type)).toEqual(['system'])
    expect(JSON.stringify(exported.notifications)).not.toContain('Nota del equipo')
    expect(JSON.stringify(exported.notifications)).not.toContain('Estados 2024.pdf')
  })

  it('keeps document_shared rows for an authorized owner', async () => {
    const withoutHistory = await exportAsOwner(tablesWithNotices())
    const active = await exportAsOwner(tablesWithNotices([ownerMembership('ACTIVE')]))

    for (const exported of [withoutHistory, active]) {
      expect(exported.notifications.map((row) => row.type)).toEqual(['system', 'document_shared'])
      expect(JSON.stringify(exported.notifications)).toContain('Nota del equipo')
    }
  })

  it('keeps document_shared rows when an admin exports a revoked owner', async () => {
    const rows = tablesWithNotices([ownerMembership('INACTIVE')])
    rows.users.push({
      _id: 'user_admin',
      _creationTime: 5,
      authProvider: 'workos',
      providerUserId: 'workos_admin',
      workosUserId: 'workos_admin',
      email: 'admin@example.com',
      role: 'ADMIN',
    })
    rows.profiles.push({
      _id: 'profile_admin',
      _creationTime: 6,
      userId: 'user_admin',
      role: 'ADMIN',
      isActive: true,
    })
    const ctx = createConvexCtx(rows, {
      identity: {
        issuer: 'https://api.workos.com/',
        subject: 'workos_admin',
        email: 'admin@example.com',
      },
    })

    const exported = await runHandler<{ profileId: string }, { notifications: ExportedNotice[] }>(
      exportUserData,
      ctx,
      { profileId: 'profile_owner' }
    )

    expect(exported.notifications.map((row) => row.type)).toEqual(['system', 'document_shared'])
    expect(JSON.stringify(exported.notifications)).toContain('Nota del equipo')
  })
})
