import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function read(relativePath: string) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

describe('temporary intake authority architecture', () => {
  it('keeps intake mode server-only, exact-true, and default-off', () => {
    // La bandera se resuelve en `demo-mode.ts`: `config.ts` quedó con la sola
    // constante del header CSRF para que los componentes `'use client'` que la
    // importan no arrastren el runtime de Effect a su first-load JS.
    const config = read('src/lib/intake/config.ts')
    const demoMode = read('src/lib/intake/demo-mode.ts')
    const env = read('src/lib/env.ts')
    const proxy = read('src/proxy.ts')

    expect(demoMode).toContain("value === 'true'")
    expect(demoMode).toContain('INTAKE_DEMO_MODE')
    expect(env).toContain('INTAKE_SERVER_SECRET')
    expect(env).toContain('INTAKE_SERVER_AUDIENCE')
    expect(`${config}\n${demoMode}\n${env}\n${proxy}`).not.toContain('NEXT_PUBLIC_INTAKE')
    expect(proxy).toContain('isIntakeDemoModeEnabled')
    expect(proxy).toContain('PUBLIC_INTAKE_API_ROUTES')
  })

  it('treats proxy allowlisting as routing only and makes the localized page resolve its cookie authority', () => {
    const page = read('src/app/[locale]/intake/page.tsx')

    expect(page).toContain('readIntakeSessionTokenFromCookieStore')
    expect(page).toContain('resolveIntakeWorkspace')
    expect(page).toContain('isIntakeDemoModeEnabled')
    expect(page).not.toContain('searchParams')
    expect(page).not.toContain('sessionToken=')
  })

  it('stores isolated digest-based intake custody', () => {
    const schema = read('convex/schema.ts')
    const intake = read('convex/intake.ts')
    const model = read('convex/_intake/model.ts')

    for (const table of [
      'intakeSessions',
      'intakeDocuments',
      'intakeUploadIntents',
      'intakeAssessments',
      'intakeEvents',
      'intakeProofNonces',
    ]) {
      expect(schema).toContain(`${table}: defineTable({`)
    }
    expect(schema).toContain('sessionTokenHash: v.string()')
    expect(schema).not.toMatch(
      /intakeSessions: defineTable\(\{[\s\S]{0,1500}sessionToken: v\.string\(\)/
    )
    expect(schema).toContain('storageState: intakeStorageStateValidator')
    expect(model).toContain("v.literal('STAGED_INTAKE')")
    expect(schema).toContain('claimDigest: v.optional(v.string())')
    expect(schema).toContain("claimedProfileId: v.optional(v.id('profiles'))")
    expect(schema).toContain("claimedCompanyId: v.optional(v.id('companies'))")
    expect(intake).not.toMatch(/insert\('profiles'|insert\('users'|insert\('companies'/)
  })

  it('binds Convex intake operations to one-use proof and exact scope', () => {
    const intake = read('convex/intake.ts')
    const proof = read('convex/_intake/serverProof.ts')

    expect(intake).toContain('consumeIntakeServerProof')
    expect(proof).toContain("query('intakeProofNonces')")
    expect(proof).toContain("insert('intakeProofNonces'")
    expect(proof).toContain('INTAKE_SERVER_AUDIENCE')
    expect(proof).not.toContain('WEBHOOK_SECRET')
    expect(intake).toContain('requireActiveIntakeSession')
    expect(intake).toContain("withIndex('by_session_createdAt'")
  })

  it('reuses upload inspection without exposing company custody', () => {
    const intake = read('convex/intake.ts')
    const storage = read('convex/_intake/storage.ts')

    for (const boundary of [
      'DIRECT_UPLOAD_ALLOWED_MIME_TYPES',
      'MAX_DIRECT_UPLOAD_BYTES',
      'detectFileSignature',
      'inspectOfficeFile',
      'inspectZipSafety',
      'scanFileWithConfiguredGateway',
    ]) {
      expect(intake).toContain(boundary)
    }
    expect(intake).toContain("'SUSPICIOUS'")
    expect(intake).toContain("'UNINSPECTED'")
    expect(intake).not.toMatch(/insert\('documents'|insert\('documentVersions'/)
    expect(storage).toContain("query('documentVersions')")
    expect(storage).toContain("query('documents')")
  })

  it('keeps browser authority out of URLs, browser storage, logs, and analytics', () => {
    const workspace = read('src/components/mycroft/IntakeWorkspace.tsx')
    const signal = read('src/components/mycroft/IntakeWorkspaceSignal.tsx')
    const routes = [
      'src/app/api/intake/session/route.ts',
      'src/app/api/intake/uploads/route.ts',
      'src/app/api/intake/uploads/register/route.ts',
      'src/app/api/intake/documents/route.ts',
    ]
      .map(read)
      .join('\n')

    expect(workspace).toContain("credentials: 'same-origin'")
    expect(workspace).not.toMatch(
      /localStorage|sessionStorage|URLSearchParams|posthog|analytics|console\./i
    )
    expect(routes).not.toMatch(/console\.log|searchParams\.set\([^)]*token|sessionToken.*log/i)
    expect(signal).toContain("'workspace_entered'")
    expect(signal).toContain("mode: 'TEMPORARY'")
    expect(signal).not.toMatch(/sessionToken|identityName|documentName|email/i)
  })

  it('keeps destination off the anonymous intake allowlist', () => {
    const proxy = read('src/proxy.ts')
    const route = read('src/app/api/intake/destination/route.ts')

    expect(proxy).toContain("'/api/intake/uploads'")
    expect(proxy).not.toContain("'/api/intake/destination'")
    expect(route).toContain('getAuthenticatedConvex')
    expect(route).toContain('getMyVdrWorkspace')
    expect(route).not.toContain('isIntakeDemoModeEnabled')
  })

  it('adds authenticated claim without coupling intake custody to external engines', () => {
    const intake = read('convex/intake.ts')
    const intakeFiles = [
      intake,
      read('convex/_intake/claim.ts'),
      read('src/components/mycroft/IntakeWorkspace.tsx'),
      read('src/app/[locale]/intake/page.tsx'),
    ].join('\n')

    expect(intakeFiles).not.toMatch(/sherlock-model-runs|modelRuns|Mycroft engine/i)
    expect(intake).toContain('claimToAuthenticatedCompany')
    // `requireAuth` y `requireAuthEffect` son la misma verificación: la segunda
    // pone el AppError en el canal de error tipado en vez de lanzarlo.
    expect(intake).toMatch(/requireAuth(?:Effect)?\(ctx\)/)
    expect(intake).toContain('resolveCurrentCompanyAuthorization')
    expect(intake).not.toContain('ensureCompanyWorkspace')
  })
})
