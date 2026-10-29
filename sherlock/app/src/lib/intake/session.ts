import { makeFunctionReference } from 'convex/server'
import { Effect } from 'effect'
import type { Id } from '@/../convex/_generated/dataModel'
import type { NextRequest, NextResponse } from 'next/server'

import { getUnauthenticatedConvex } from '@/lib/convex-auth'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import { createIntakeServerProof } from './proof'

const INTAKE_SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60

export type IntakeDocumentView = {
  id: string
  displayName: string
  declaredMimeType: string
  byteSize: number
  inspectionStatus: 'CLEAN' | 'NOT_CONFIGURED' | 'UNINSPECTED' | 'SUSPICIOUS'
  claimable: boolean
  createdAt: number
}

export type IntakeAssessmentFindingView = {
  category:
    | 'financialStatements'
    | 'notes'
    | 'businessExplanation'
    | 'language'
    | 'businessModel'
    | 'pitch'
    | 'teaserCim'
    | 'loanPaymentTape'
    | 'financialModel'
    | 'portfolioDetail'
    | 'legalDetail'
    | 'country'
  evidenceDocumentIds: string[]
  confidence: number
  reviewState: 'PENDING' | 'CONFIRMED' | 'REJECTED'
}

export type IntakeAssessmentView = {
  id: string
  intakeSessionId: string
  status: 'PENDING' | 'NEEDS_REVIEW' | 'READY'
  source: 'TEAM' | 'EXTERNAL'
  findings: IntakeAssessmentFindingView[]
  createdAt: number
  updatedAt: number
}

export type IntakeWorkspaceView = {
  authorized: boolean
  accessExpiresAt?: number
  identityName?: string
  documents: IntakeDocumentView[]
  assessment?: IntakeAssessmentView | null
}

type ServerProof = {
  serverIssuedAt: number
  proofNonce: string
  serverProof: string
}

export const createIntakeSessionRef = makeFunctionReference<
  'mutation',
  {
    anonymousKey: string
    identityName?: string
  } & ServerProof,
  {
    sessionToken: string
    accessExpiresAt: number
    deletionProofExpiresAt: number
    workspace: Omit<IntakeWorkspaceView, 'authorized'> & { authorized: true }
  }
>('intake:createSession')

export const projectIntakeWorkspaceRef = makeFunctionReference<
  'mutation',
  { sessionToken: string } & ServerProof,
  | { authenticated: false }
  | ({ authenticated: true } & Omit<IntakeWorkspaceView, 'authorized'> & { authorized: true })
>('intake:projectWorkspace')

export const rotateIntakeSessionRef = makeFunctionReference<
  'mutation',
  { sessionToken: string; identityName?: string } & ServerProof,
  | { rotated: false }
  | {
      rotated: true
      sessionToken: string
      accessExpiresAt: number
      deletionProofExpiresAt: number
      workspace: Omit<IntakeWorkspaceView, 'authorized'> & { authorized: true }
    }
>('intake:rotateSession')

export const revokeIntakeSessionRef = makeFunctionReference<
  'mutation',
  { sessionToken: string } & ServerProof,
  { revoked: true }
>('intake:revokeSession')

export const deleteIntakeDataRef = makeFunctionReference<
  'mutation',
  { sessionToken: string } & ServerProof,
  { deleted: true }
>('intake:deleteData')

export const issueIntakeUploadIntentRef = makeFunctionReference<
  'mutation',
  {
    sessionToken: string
    fileName: string
    declaredMimeType: string
    declaredByteSize: number
    declaredSha256: string
    supersedePending?: boolean
  } & ServerProof,
  | { alreadyRegistered: true; document: IntakeDocumentView }
  | {
      alreadyRegistered: false
      intentId: Id<'intakeUploadIntents'>
      uploadUrl: string
      expiresAt: number
    }
  | { registered: false; code: 'FILE_TOO_LARGE' }
>('intake:issueUploadIntent')

export const registerIntakeUploadRef = makeFunctionReference<
  'action',
  {
    sessionToken: string
    intentId: Id<'intakeUploadIntents'>
    storageId: Id<'_storage'>
  } & ServerProof,
  {
    registered: boolean
    code?: string
    document?: IntakeDocumentView
  }
>('intake:inspectAndRegisterUpload')

export function getIntakeSessionCookieName(
  nodeEnv: string | undefined = process.env.NODE_ENV
): string {
  return nodeEnv === 'production' ? '__Host-sherlock-intake' : 'sherlock-intake-dev'
}

export function intakeSessionCookieOptions(nodeEnv: string | undefined = process.env.NODE_ENV) {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    // The temporary authority must survive the top-level WorkOS OAuth callback
    // so the authenticated subject can claim the room. State-changing intake
    // APIs still require the separate Strict CSRF cookie and header proof.
    sameSite: 'lax' as const,
    path: '/',
  }
}

export function readIntakeSessionToken(request: NextRequest): string | null {
  const value = request.cookies.get(getIntakeSessionCookieName())?.value ?? null
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}

export function readIntakeSessionTokenFromCookieStore(cookieStore: {
  get(name: string): { value: string } | undefined
}): string | null {
  const value = cookieStore.get(getIntakeSessionCookieName())?.value ?? null
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null
}

export function setIntakeSessionCookie(
  response: NextResponse,
  sessionToken: string,
  deletionProofExpiresAt: number,
  now = Date.now()
): void {
  const maxAge = Math.max(
    1,
    Math.min(
      INTAKE_SESSION_COOKIE_MAX_AGE_SECONDS,
      Math.floor((deletionProofExpiresAt - now) / 1000)
    )
  )
  response.cookies.set(getIntakeSessionCookieName(), sessionToken, {
    ...intakeSessionCookieOptions(),
    maxAge,
    expires: new Date(now + maxAge * 1000),
  })
}

export function clearIntakeSessionCookie(response: NextResponse): void {
  response.cookies.set(getIntakeSessionCookieName(), '', {
    ...intakeSessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  })
}

export type IntakeCookieWriter = {
  set(
    name: string,
    value: string,
    options: {
      httpOnly: boolean
      secure: boolean
      sameSite: 'lax' | 'strict'
      path: string
      maxAge: number
      expires: Date
    }
  ): unknown
}

/**
 * En producción la cookie lleva el prefijo `__Host-`, y el navegador solo acepta
 * un Set-Cookie de ese nombre si trae `Secure` y `Path=/`. `cookieStore.delete()`
 * emite el borrado sin ninguno de los dos, así que el navegador lo rechaza y la
 * cookie sobrevive al claim. Se borra escribiéndola vacía con los mismos
 * atributos con que se puso.
 */
export function clearIntakeSessionCookieInStore(cookieStore: IntakeCookieWriter): void {
  cookieStore.set(getIntakeSessionCookieName(), '', {
    ...intakeSessionCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  })
}

const resolveIntakeWorkspaceEffect = Effect.fn('IntakeSession.resolveWorkspace')(function* (
  sessionToken: string
) {
  const client = getUnauthenticatedConvex()
  if (!client) return null
  const result = yield* externalCall({
    service: 'Convex',
    operation: 'intake.projectWorkspace',
    // Sin reintento: el proof del intake es de un solo uso
    // (`intakeProofNonces`), así que una segunda vuelta con el mismo nonce la
    // rechazaría el propio servidor. El techo de tiempo sí entra: esto corre
    // dentro del render de la sala temporal, donde colgarse es peor que
    // renderizar sin documentos, que es lo mismo que ya hacía el `catch`.
    retries: 0,
    run: () =>
      client.mutation(projectIntakeWorkspaceRef, {
        sessionToken,
        ...createIntakeServerProof({
          operation: 'PROJECT_WORKSPACE',
          bindingParts: [sessionToken],
        }),
      }),
  })
  if (!result.authenticated || !result.authorized) return null
  return {
    authorized: true,
    accessExpiresAt: result.accessExpiresAt,
    identityName: result.identityName,
    documents: result.documents,
    assessment: result.assessment ?? null,
  }
})

/** Puente a Promise para la página `[locale]/intake`, que es un Server Component. */
export function resolveIntakeWorkspace(sessionToken: string): Promise<IntakeWorkspaceView | null> {
  return runServerEffect(
    resolveIntakeWorkspaceEffect(sessionToken).pipe(Effect.catchCause(() => Effect.succeed(null)))
  )
}
