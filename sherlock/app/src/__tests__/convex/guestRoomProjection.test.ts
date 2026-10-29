// ============================================================================
// PROYECCIÓN DE LA SALA DEL INVITADO — LA COMPUERTA, NO EL CONTENIDO
// ============================================================================
// La sala por transacción salió del árbol ([F] 2026-09-17), y con ella el ciclo
// de acceso, sus grants, el panel publicado y el Q&A. Lo que sigue vivo — y lo
// que este archivo prueba a través de la mutation pública — es que la
// proyección solo cruza por el sobre firmado del servidor de Next y que una
// sesión válida NO es autorización de sala: sin el NDA aceptado, el invitado
// recibe la compuerta y ningún documento.
//
// El contenido de la sala de empresa (qué versión exacta se entrega, qué pasa
// con una versión reemplazada, un NDA desactivado o una sesión vencida) lo
// prueba `company-guest-access.test.ts`.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getGuestRoomProjection } from '../../../convex/guestAccess'
import { hashGuestSessionToken } from '../../../convex/_guests/crypto'
import { sha256Hex } from '../../../convex/_adminVdr/capability'
import { createVdrGuestServerProof } from '@/lib/auth/vdr-guest-server-proof'
import { createConvexCtx, runHandler, type Tables } from './nda-convex-harness'

const NOW = 1_800_000_000_000
const SESSION_TOKEN = 's'.repeat(64)
const SERVER_SECRET = 'server-boundary-secret-for-tests-123456789'
const SERVER_AUDIENCE = 'sherlock-test:guest-boundary'
const NDA_CONTENT = 'TEST FIXTURE ONLY. Approved confidentiality text.'

function projectionServerProof() {
  return createVdrGuestServerProof({
    operation: 'PROJECT_ROOM',
    bindingParts: [SESSION_TOKEN],
    issuedAt: NOW,
    secret: SERVER_SECRET,
    audience: SERVER_AUDIENCE,
  })
}

async function projectionTables(): Promise<Tables> {
  return {
    companies: [{ _id: 'company_1', ownerId: 'profile_owner', name: 'Issuer One' }],
    profiles: [
      { _id: 'profile_owner', userId: 'user_owner', role: 'COMPANY', isActive: true },
      { _id: 'profile_admin', userId: 'user_admin', role: 'ADMIN', isActive: true },
    ],
    guestNdaTemplates: [
      {
        _id: 'template_1',
        companyId: 'company_1',
        title: 'Test NDA',
        content: NDA_CONTENT,
        contentHash: await sha256Hex(NDA_CONTENT),
        locale: 'es',
        version: 'v1',
        active: true,
        approvedAt: NOW - 100_000,
        approvedByProfileId: 'profile_admin',
      },
    ],
    guestInvitations: [
      {
        _id: 'invitation_1',
        companyId: 'company_1',
        companyRoom: {
          documents: [{ documentId: 'document_1', versionId: 'version_1' }],
          ndaTemplateId: 'template_1',
        },
        guestId: 'guest_1',
        principalKey: 'GUEST:guest_1',
        emailHash: 'email_hash',
        emailMasked: 'g***@example.com',
        invitationHandleHash: 'handle_hash',
        status: 'VERIFIED',
        createdAt: NOW - 60_000,
        createdByProfileId: 'profile_owner',
        expiresAt: NOW + 3_600_000,
        verifiedAt: NOW - 30_000,
      },
    ],
    guestSessions: [],
    guestNdaAcceptances: [],
    documents: [
      {
        _id: 'document_1',
        companyId: 'company_1',
        name: 'Estados financieros.pdf',
        folder: 'Financieros',
        accessLevel: 'NDA_REQUIRED',
        classification: 'CONFIDENTIAL',
        lifecycleStatus: 'ACTIVE',
        currentVersionId: 'version_1',
        publishedVersionId: 'version_1',
        currentVersionNumber: 1,
        storageId: 'storage_1',
      },
    ],
    documentVersions: [
      {
        _id: 'version_1',
        documentId: 'document_1',
        companyId: 'company_1',
        versionNumber: 1,
        storageId: 'storage_1',
        displayName: 'Estados financieros.pdf',
        declaredMimeType: 'application/pdf',
        detectedMimeType: 'application/pdf',
        byteSize: 2_048,
        sha256: 'a'.repeat(64),
        signatureKind: 'PDF',
        verificationStatus: 'SIGNATURE_VERIFIED',
        malwareScanStatus: 'CLEAN',
        publicationStatus: 'PUBLISHED',
        publishedAt: NOW - 50_000,
        createdAt: NOW - 50_000,
        createdByProfileId: 'profile_owner',
      },
    ],
    rateLimits: [],
    activityLogs: [],
  }
}

async function seedSession(tables: Tables) {
  tables.guestSessions.push({
    _id: 'session_1',
    guestInvitationId: 'invitation_1',
    guestId: 'guest_1',
    principalKey: 'GUEST:guest_1',
    sessionTokenHash: await hashGuestSessionToken(SESSION_TOKEN),
    status: 'ACTIVE',
    createdAt: NOW - 10_000,
    expiresAt: NOW + 30 * 60_000,
  })
}

describe('permission-trimmed guest room projection', () => {
  beforeEach(() => {
    vi.stubEnv('GUEST_IDENTITY_HASH_SECRET', 'i'.repeat(32))
    vi.stubEnv('GUEST_OTP_PEPPER', 'o'.repeat(32))
    vi.stubEnv('VDR_GUEST_SERVER_SECRET', SERVER_SECRET)
    vi.stubEnv('VDR_GUEST_SERVER_AUDIENCE', SERVER_AUDIENCE)
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('rejects a direct Convex call that did not cross the hardened Next server boundary', async () => {
    const tables = await projectionTables()
    await seedSession(tables)

    await expect(
      runHandler(getGuestRoomProjection, createConvexCtx(tables), {
        sessionToken: SESSION_TOKEN,
        serverIssuedAt: NOW,
        serverProof: 'invalid',
      })
    ).rejects.toThrow(/servidor/i)
  })

  it('never treats a verified email and valid session as room authorization', async () => {
    const tables = await projectionTables()
    await seedSession(tables)

    const result = await runHandler(getGuestRoomProjection, createConvexCtx(tables), {
      sessionToken: SESSION_TOKEN,
      ...projectionServerProof(),
    })

    expect(result).toEqual({
      authenticated: true,
      expiresAt: NOW + 30 * 60_000,
      roomAccessGranted: false,
      requiredGates: ['NDA'],
    })
    expect(result).not.toHaveProperty('guestId')
    expect(result).not.toHaveProperty('principalKey')
    expect(result).not.toHaveProperty('documents')
  })

  // Sin el sobre `companyRoom` la invitación no ancla documentos ni plantilla:
  // la proyección falla cerrada en vez de degradar a "sin documentos".
  it('fails closed for an invitation without the company-room envelope', async () => {
    const tables = await projectionTables()
    await seedSession(tables)
    delete tables.guestInvitations[0].companyRoom

    await expect(
      runHandler(getGuestRoomProjection, createConvexCtx(tables), {
        sessionToken: SESSION_TOKEN,
        ...projectionServerProof(),
      })
    ).resolves.toEqual({ authenticated: false })
  })
})
