// ============================================================================
// Union discriminado de grants — lo que el cliente y la ruta HTTP usan
// ============================================================================
// `getDownloadUrl` todavía puede devolver un string (URL legada) o un deny
// estructurado. El visor y `/api/documents/access` solo tratan como éxito un
// grant con action/version/MIME. Sin estos guards, un URL suelto o un deny
// incompleto se interpretan como apertura y se pierde la denegación auditada.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  deniedDocumentAccess,
  isDeniedDocumentAccess,
  isIssuedDocumentAccessGrant,
} from '../../../convex/_documents/accessResult'

const ISSUED = {
  allowed: true as const,
  url: '/api/documents/access/grant_1?token=plain',
  action: 'VIEW' as const,
  versionId: 'version_1',
  displayName: 'memo.pdf',
  detectedMimeType: 'application/pdf',
}

describe('deniedDocumentAccess', () => {
  it('projects the policy outcome into the structured denial the UI can map', () => {
    expect(
      deniedDocumentAccess({
        decision: 'REQUIRE_STEP_UP',
        outcome: 'REQUIRE_SIGNED_NDA',
        reason: 'Debes firmar un NDA activo antes de acceder.',
        classification: 'CONFIDENTIAL',
        riskScore: 35,
        stepUpRequirement: 'SIGNED_NDA',
      })
    ).toEqual({
      allowed: false,
      code: 'REQUIRE_SIGNED_NDA',
      message: 'Debes firmar un NDA activo para acceder a este documento.',
    })
  })
})

describe('isDeniedDocumentAccess', () => {
  it('accepts only a complete allowed:false payload', () => {
    expect(
      isDeniedDocumentAccess({ allowed: false, code: 'REQUIRE_SIGNED_NDA', message: 'NDA' })
    ).toBe(true)
    expect(isDeniedDocumentAccess({ allowed: false, code: 'REQUIRE_SIGNED_NDA' })).toBe(false)
    expect(isDeniedDocumentAccess(ISSUED)).toBe(false)
    expect(isDeniedDocumentAccess(ISSUED.url)).toBe(false)
    expect(isDeniedDocumentAccess(null)).toBe(false)
  })
})

describe('isIssuedDocumentAccessGrant', () => {
  it('rejects the legacy URL string and a partial success object', () => {
    expect(isIssuedDocumentAccessGrant(ISSUED)).toBe(true)
    expect(isIssuedDocumentAccessGrant({ ...ISSUED, action: 'DOWNLOAD' })).toBe(true)
    expect(isIssuedDocumentAccessGrant(ISSUED.url)).toBe(false)
    expect(isIssuedDocumentAccessGrant({ allowed: true, url: ISSUED.url })).toBe(false)
    expect(
      isIssuedDocumentAccessGrant({
        allowed: true,
        url: ISSUED.url,
        action: 'PREVIEW',
        versionId: ISSUED.versionId,
        displayName: ISSUED.displayName,
        detectedMimeType: ISSUED.detectedMimeType,
      })
    ).toBe(false)
    expect(isIssuedDocumentAccessGrant({ allowed: false, code: 'X', message: 'Y' })).toBe(false)
  })
})
