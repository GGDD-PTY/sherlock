import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hashIntakeSessionToken, sha256Hex } from '../../../convex/_intake/crypto'
import { getIntakeSupport, sendIntakeSupportMessage } from '../../../convex/intake'
import { createIntakeServerProof } from '../../lib/intake/proof'
import { createConvexCtx, runHandler, type Row, type Tables } from './nda-convex-harness'

const SECRET = 'intake-support-secret-for-tests-1234567890'
const AUDIENCE = 'sherlock-test:intake-support'
const SESSION_TOKEN = 's'.repeat(43)
let nonce = 0

function row(overrides: Partial<Row> & Pick<Row, '_id'>): Row {
  return { _creationTime: 1, ...overrides }
}

async function tables(): Promise<Tables> {
  return {
    intakeSessions: [
      row({
        _id: 'intake_session_1',
        sessionTokenHash: await hashIntakeSessionToken(SESSION_TOKEN),
        anonymousKeyHash: 'a'.repeat(64),
        audience: AUDIENCE,
        status: 'ACTIVE',
        claimStatus: 'UNCLAIMED',
        createdAt: Date.now() - 1_000,
        accessExpiresAt: Date.now() + 60_000,
        absoluteExpiresAt: Date.now() + 120_000,
        deletionProofExpiresAt: Date.now() + 180_000,
        rotationCount: 0,
        documentCount: 0,
        totalStagedBytes: 0,
      }),
    ],
    intakeDocuments: [],
    intakeUploadIntents: [],
    intakeAssessments: [],
    intakeEvents: [],
    intakeProofNonces: [],
    supportThreads: [],
    supportMessages: [],
    rateLimits: [],
  }
}

function proof(operation: 'SUPPORT_READ' | 'SUPPORT_SEND', bindingParts: string[]) {
  nonce += 1
  return createIntakeServerProof({
    operation,
    bindingParts,
    nonce: Buffer.alloc(24, nonce).toString('base64url'),
  })
}

describe('temporary intake support', () => {
  beforeEach(() => {
    vi.stubEnv('INTAKE_DEMO_MODE', 'true')
    vi.stubEnv('INTAKE_SERVER_SECRET', SECRET)
    vi.stubEnv('INTAKE_SERVER_AUDIENCE', AUDIENCE)
    vi.useFakeTimers()
    vi.setSystemTime(1_900_000_000_000)
    nonce = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('creates one intake-scoped thread and returns inert bounded messages', async () => {
    const state = await tables()
    const ctx = createConvexCtx(state)
    const body = '<script>alert("text only")</script>'

    const sent = (await runHandler(sendIntakeSupportMessage, ctx, {
      sessionToken: SESSION_TOKEN,
      body,
      ...proof('SUPPORT_SEND', [SESSION_TOKEN, await sha256Hex(body)]),
    })) as { message: { authorKind: string; body: string; sequence: number } }

    expect(sent.message).toMatchObject({ authorKind: 'INTAKE', body, sequence: 1 })
    expect(state.supportThreads).toHaveLength(1)
    expect(state.supportThreads[0]).toMatchObject({
      scope: { kind: 'INTAKE', intakeSessionId: 'intake_session_1' },
      scopeKey: 'intake:intake_session_1',
      adminUnread: true,
      adminUnreadCount: 1,
    })

    const read = (await runHandler(getIntakeSupport, ctx, {
      sessionToken: SESSION_TOKEN,
      ...proof('SUPPORT_READ', [SESSION_TOKEN]),
    })) as { messages: Array<{ body: string }> }
    expect(read.messages).toEqual([expect.objectContaining({ body })])
    expect(state.supportThreads[0]).toMatchObject({ clientUnread: false, clientUnreadCount: 0 })
  })

  it('requires an active session and a matching one-use server proof', async () => {
    const state = await tables()
    const ctx = createConvexCtx(state)
    const body = 'Necesito ayuda'
    const signed = proof('SUPPORT_SEND', [SESSION_TOKEN, await sha256Hex(body)])

    await runHandler(sendIntakeSupportMessage, ctx, {
      sessionToken: SESSION_TOKEN,
      body,
      ...signed,
    })
    await expect(
      runHandler(sendIntakeSupportMessage, ctx, {
        sessionToken: SESSION_TOKEN,
        body,
        ...signed,
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })

    state.intakeSessions[0].status = 'EXPIRED'
    await expect(
      runHandler(getIntakeSupport, ctx, {
        sessionToken: SESSION_TOKEN,
        ...proof('SUPPORT_READ', [SESSION_TOKEN]),
      })
    ).rejects.toMatchObject({ data: { code: 'AUTHZ_UNAUTHORIZED' } })
  })
})
