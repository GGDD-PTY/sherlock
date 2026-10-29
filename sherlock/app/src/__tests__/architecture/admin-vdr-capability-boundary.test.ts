import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function read(relativePath: string) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

const protectedActionsByModule = {
  'convex/_documents/mutations.ts': [
    'DOCUMENT_CREATE',
    'DOCUMENT_UPDATE',
    'DOCUMENT_ARCHIVE',
    'DOCUMENT_PURGE',
  ],
  'convex/_documents/uploadIntents.ts': ['DOCUMENT_UPLOAD_INTENT'],
  'convex/_documents/versions.ts': ['DOCUMENT_VERSION_RESTORE'],
  'convex/_documents/bulk.ts': ['DOCUMENT_BULK_UPDATE'],
  'convex/_documents/governance.ts': ['DOCUMENT_LEGAL_HOLD_PLACE', 'DOCUMENT_LEGAL_HOLD_RELEASE'],
  'convex/guestAccess.ts': ['GUEST_EXTEND', 'GUEST_REVOKE'],
} as const

describe('delegated admin VDR capability architecture', () => {
  it.each(Object.entries(protectedActionsByModule))(
    '%s keeps every privileged VDR action on the delegated capability kernel',
    (relativePath, actions) => {
      const source = read(relativePath)

      expect(source).toContain('adminVdrCapabilityValidator')
      expect(source).toContain('requireAdminVdrCapability')
      for (const action of actions) expect(source).toContain(`'${action}'`)
    }
  )

  it('keeps issuance same-origin, step-up gated, strict, and server-authenticated', () => {
    const route = read('src/app/api/admin/vdr-capabilities/route.ts')
    const issuer = read('convex/adminVdrCapabilities.ts')

    expect(route).toContain('rejectNonExactSameOrigin')
    expect(route).toContain('requireAdminApiAuth')
    expect(route).toContain('canonicalizeAdminVdrInput')
    expect(route).toContain('issueAdminVdrCapability')
    expect(issuer).toContain('requireAdminVdrCapabilityServerProof')
    expect(issuer).toContain("auth.identity.authProvider !== 'workos'")
    expect(issuer).toContain('subject: auth.identity.subject')
    expect(issuer).toContain('sessionId: auth.identity.sessionId')
    expect(issuer).not.toContain('subject: v.string()')
    expect(issuer).not.toContain('sessionId: v.string()')
  })

  it('persists bearer hashes only and consumes with bounded audit evidence in the caller transaction', () => {
    const schema = read('convex/schema.ts')
    const issuer = read('convex/adminVdrCapabilities.ts')
    const consumer = read('convex/_adminVdr/capability.ts')

    expect(schema).toContain('adminVdrCapabilities: defineTable')
    expect(schema).toContain('tokenHash: v.string()')
    expect(schema).toContain('identityBindingDigest: v.string()')
    expect(schema).not.toMatch(/adminVdrCapabilities: defineTable\(\{[\s\S]{0,500}\bsubject:/)
    expect(schema).not.toMatch(/adminVdrCapabilities: defineTable\(\{[\s\S]{0,500}\bsessionId:/)
    expect(issuer).not.toMatch(/insert\('adminVdrCapabilities',[\s\S]{0,500}\bcapability\b/)
    expect(issuer).toContain("action: 'VDR_ADMIN_CAPABILITY_ISSUE'")
    expect(consumer).toContain("action: 'VDR_ADMIN_CAPABILITY_CONSUME'")
    // Lo que este aserto fija es que el consumo se marca DENTRO de la
    // transacción del llamador, con `args.ctx`, no con un contexto propio. Con
    // la costura de Convex ese `await` pasa a ser `convexPromise(() => ...)`:
    // el patch sigue en la misma transacción, cambia quién lo espera.
    expect(consumer).toMatch(
      /(?:await|convexPromise\(\(\) =>) args\.ctx\.db\.patch\(row\._id, \{ consumedAt: now \}\)/
    )
    expect(read('convex/crons.ts')).toContain('purge-expired-admin-vdr-capabilities')
  })

  it('keeps the browser bearer off URLs, cookies, storage, caches, and logs', () => {
    const source = read('src/components/company/vdr/AdminVdrCapabilityContext.tsx')

    expect(source).toContain("fetch('/api/admin/vdr-capabilities'")
    expect(source).toContain("credentials: 'same-origin'")
    expect(source).not.toMatch(/localStorage\.|sessionStorage\.|document\.cookie|console\./)
    expect(source).not.toContain('cache:')
  })

  // La cola multiempresa de solicitudes salió con el subsistema de
  // transacciones ([F] 2026-09-17). El panel de invitados de la sala de empresa
  // es el que queda atado a la capability delegada con su empresa exacta.
  it('binds the company guest panel to the exact company and raw mutation input', () => {
    const source = read('src/components/vdr-guest/CompanyGuestPanel.tsx')

    for (const action of ['GUEST_INVITE', 'GUEST_REVOKE']) {
      expect(source).toContain(`'${action}'`)
    }
    expect(source).toContain('useAdminVdrCapability')
  })
})
