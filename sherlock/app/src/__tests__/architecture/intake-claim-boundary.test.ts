import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function read(relativePath: string) {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

describe('durable intake claim architecture', () => {
  it('derives company scope from authenticated ownership and accepts no client company/profile id', () => {
    const route = read('src/app/api/intake/claim/route.ts')
    const intake = read('convex/intake.ts')

    // `requireAuth` y `requireAuthEffect` son la misma verificación: la segunda
    // pone el AppError en el canal de error tipado en vez de lanzarlo.
    expect(intake).toMatch(/requireAuth(?:Effect)?\(ctx\)/)
    expect(intake).toContain('resolveCurrentCompanyAuthorization')
    expect(intake).toContain("authorization.access !== 'MANAGE'")
    expect(route).toContain('getAuthenticatedConvex')
    expect(route).not.toContain('request.json')
    expect(intake).toMatch(
      /claimToAuthenticatedCompany = mutation\(\{[\s\S]*?args: \{[\s\S]*?sessionToken:[\s\S]*?workosSubject:[\s\S]*?claimNonce:[\s\S]*?claimProof:[\s\S]*?\},/
    )
    expect(intake).not.toMatch(
      /claimToAuthenticatedCompany = mutation\(\{[\s\S]{0,500}(companyId|profileId): v\./
    )
  })

  it('schedules internal reconciliation after prepare so a dropped client cannot strand PROCESSING', () => {
    const claim = read('convex/_intake/claim.ts')
    const intake = read('convex/intake.ts')

    expect(claim).toContain("'intake:_reconcileClaim'")
    expect(claim).toContain('scheduler.runAfter(0, reconcileClaimRef')
    expect(intake).toContain('export const _reconcileClaim = internalMutation')
    expect(intake).toContain('reconcileIntakeClaimByDigest(ctx, args.claimDigest)')
  })

  it('uses one stable subject-bound digest and a terminal replay result', () => {
    const claim = read('convex/_intake/claim.ts')
    const claimClient = read('src/lib/intake/claim.ts')
    const claimProof = read('convex/_intake/claimProof.ts')

    // Un solo módulo compartido versiona el payload del digest; ambos lados
    // construyen el proof desde él en vez de duplicar el formato.
    expect(claimProof).toContain("'intake-claim.v1'")
    expect(claim).toContain('buildIntakeClaimProofPayload')
    expect(claimClient).toContain('buildIntakeClaimProofPayload')
    expect(claim).toContain('workosSubject')
    expect(claim).toContain("withIndex('by_claimDigest'")
    expect(claim).toContain('claimResult')
    expect(claim).toContain("claimStatus: 'PROCESSING'")
    expect(claim).toContain("claimStatus: 'FAILED'")
    expect(claim).toContain("claimStatus: 'CLAIMED'")
  })

  it('transfers metadata around the same storage id without upload, copy, or deletion', () => {
    const claim = read('convex/_intake/claim.ts')

    expect(claim).toContain("insert('documents'")
    expect(claim).toContain("insert('documentVersions'")
    expect(claim).toContain("storageState: 'OWNED_BY_COMPANY'")
    expect(claim).toContain('versionNumber: 1')
    expect(claim).toContain('replacesVersionId: undefined')
    expect(claim).not.toMatch(/generateUploadUrl|storage\.store|storage\.delete/)
  })

  it('rotates temporary authority only after successful reconciliation', () => {
    const claim = read('convex/_intake/claim.ts')
    const route = read('src/app/api/intake/claim/route.ts')

    expect(claim).toContain("status: 'CLAIMED'")
    expect(claim).toContain('sessionTokenHash')
    expect(claim).toContain("revokedReason: 'CLAIM_SUCCEEDED'")
    expect(route).toContain('clearIntakeSessionCookie')
    expect(route).toContain('clearIntakeCsrfCookie')
  })

  it('keeps Mycroft and model-runs protocols outside the custody transition', () => {
    const files = [
      read('convex/intake.ts'),
      read('convex/_intake/claim.ts'),
      read('src/lib/intake/claim.ts'),
      read('src/app/api/intake/claim/route.ts'),
    ].join('\n')

    expect(files).not.toMatch(/modelRuns|sherlock-model-runs|MCP protocol|Mycroft engine/i)
  })

  it('retries a dropped callback claim from the durable data room, never from onboarding', () => {
    const documentsClient = read('src/components/company/MyCompanyDocumentsClient.tsx')
    // /onboarding es un route handler (307 por HTTP) con una sola page hija,
    // la hoja de aprovisionamiento: ninguna de las dos reintenta el claim.
    const onboarding = [
      read('src/app/[locale]/(app)/onboarding/route.ts'),
      read('src/app/[locale]/(app)/onboarding/provision/page.tsx'),
    ].join('\n')
    const provisioning = read('src/components/onboarding/WorkspaceProvisioning.tsx')

    expect(documentsClient).toContain('INTAKE_CLAIM_RETRY_COOKIE')
    expect(documentsClient).toContain('/api/intake/claim')
    expect(onboarding).not.toMatch(/intake\/claim|INTAKE_CLAIM_RETRY/)
    expect(provisioning).not.toMatch(/intake\/claim|INTAKE_CLAIM_RETRY/)
  })

  it('keeps claim proofs outside the one-use server-proof operation set', () => {
    const model = read('convex/_intake/model.ts')
    const proofFormat = read('convex/_intake/proofFormat.ts')
    const validator = model.match(
      /export const intakeProofOperationValidator = v\.union\(([\s\S]*?)\n\)/
    )?.[1]

    expect(validator).toContain("v.literal('DELETE_DATA')")
    expect(validator).not.toMatch(/CLAIM/)
    expect(proofFormat).not.toContain("'CLAIM'")
    expect(proofFormat).not.toContain('CLAIM_TO_COMPANY')
  })
})
