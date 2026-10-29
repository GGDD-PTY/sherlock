import { describe, expect, it } from 'vitest'

import {
  FEATURE_TOTAL_BREAKER,
  REQUESTS_GLOBAL_BREAKER,
  REQUESTS_PER_DEVICE_PER_DAY,
  VOTED_FEATURES_CAP,
} from '../../../convex/_roadmap/model'
import { getDeviceVotes, getVoteTotals, submitFeatureRequest, vote } from '../../../convex/roadmap'
import { createConvexCtx, runHandler, type Row } from './nda-convex-harness'

const DEVICE = 'aaaaaaaaaaaaaaaa'
const OTHER_DEVICE = 'bbbbbbbbbbbbbbbb'
const VOTABLE = 'guestRooms'
const OTHER_VOTABLE = 'marketplace'
const SHIPPED = 'bilingual'

function voteRow(id: string, featureKey: string, deviceToken: string, count?: number): Row {
  return {
    _id: id,
    _creationTime: 1,
    featureKey,
    deviceToken,
    ...(count === undefined ? {} : { count }),
  }
}

describe('roadmap.getVoteTotals', () => {
  it('only counts registry keys and ignores unknown ones', async () => {
    const ctx = createConvexCtx({
      roadmapVoteTotals: [
        { _id: 'total_guest', featureKey: VOTABLE, total: 4 },
        { _id: 'total_ghost', featureKey: 'not-in-registry', total: 99 },
        { _id: 'total_vdr', featureKey: 'vdr', total: 2 },
      ],
    })

    const totals = await runHandler<Record<string, never>, Record<string, number>>(
      getVoteTotals,
      ctx,
      {}
    )

    expect(totals).toEqual({ guestRooms: 4, vdr: 2 })
  })
})

describe('roadmap.getDeviceVotes', () => {
  it('returns an empty budget for an invalid token instead of throwing', async () => {
    const ctx = createConvexCtx({
      roadmapVotes: [voteRow('vote_1', VOTABLE, DEVICE)],
    })

    const result = await runHandler(getDeviceVotes, ctx, { deviceToken: 'too-short' })

    expect(result).toEqual({
      featureKeys: [],
      remaining: VOTED_FEATURES_CAP,
      cap: VOTED_FEATURES_CAP,
    })
  })

  it('counts every stored vote against the budget, including shipped keys', async () => {
    const ctx = createConvexCtx({
      roadmapVotes: [
        voteRow('vote_1', VOTABLE, DEVICE),
        voteRow('vote_2', SHIPPED, DEVICE),
        voteRow('vote_3', OTHER_VOTABLE, OTHER_DEVICE),
      ],
    })

    const result = await runHandler<
      { deviceToken: string },
      { featureKeys: string[]; remaining: number; cap: number }
    >(getDeviceVotes, ctx, { deviceToken: DEVICE })

    expect(new Set(result.featureKeys)).toEqual(new Set([SHIPPED, VOTABLE]))
    expect(result.remaining).toBe(1)
    expect(result.cap).toBe(VOTED_FEATURES_CAP)
  })
})

describe('roadmap.vote', () => {
  it('rejects an invalid device token', async () => {
    const ctx = createConvexCtx({ roadmapVotes: [], roadmapVoteTotals: [] })

    await expect(
      runHandler(vote, ctx, { featureKey: VOTABLE, deviceToken: 'bad' })
    ).rejects.toThrow(/dispositivo inválido/)
  })

  it('rejects a new vote on a key that is no longer votable', async () => {
    const ctx = createConvexCtx({ roadmapVotes: [], roadmapVoteTotals: [] })

    await expect(
      runHandler(vote, ctx, { featureKey: SHIPPED, deviceToken: DEVICE })
    ).rejects.toThrow(/no admite votos/)
  })

  it('inserts the first vote and opens the public total', async () => {
    const ctx = createConvexCtx({ roadmapVotes: [], roadmapVoteTotals: [] })

    const result = await runHandler(vote, ctx, { featureKey: VOTABLE, deviceToken: DEVICE })

    expect(result).toEqual({ accepted: true, voted: true, remaining: 2 })
    expect(ctx.tables.roadmapVotes).toHaveLength(1)
    expect(ctx.tables.roadmapVoteTotals).toEqual([
      expect.objectContaining({ featureKey: VOTABLE, total: 1 }),
    ])
  })

  it('increments an existing total on a later vote', async () => {
    const ctx = createConvexCtx({
      roadmapVotes: [],
      roadmapVoteTotals: [{ _id: 'total_guest', featureKey: VOTABLE, total: 7 }],
    })

    await runHandler(vote, ctx, { featureKey: VOTABLE, deviceToken: DEVICE })

    expect(ctx.tables.roadmapVoteTotals[0]).toMatchObject({ total: 8 })
  })

  it('toggles an existing vote off and subtracts its stored weight', async () => {
    const ctx = createConvexCtx({
      roadmapVotes: [voteRow('vote_old', SHIPPED, DEVICE, 3)],
      roadmapVoteTotals: [{ _id: 'total_shipped', featureKey: SHIPPED, total: 5 }],
    })

    const result = await runHandler(vote, ctx, { featureKey: SHIPPED, deviceToken: DEVICE })

    expect(result).toEqual({ accepted: true, voted: false, remaining: 3 })
    expect(ctx.tables.roadmapVotes).toEqual([])
    expect(ctx.tables.roadmapVoteTotals[0]).toMatchObject({ total: 2 })
  })

  it('refuses a fourth distinct vote without throwing', async () => {
    const ctx = createConvexCtx({
      roadmapVotes: [
        voteRow('vote_1', 'vdr', DEVICE),
        voteRow('vote_2', 'theme', DEVICE),
        voteRow('vote_3', SHIPPED, DEVICE),
      ],
      roadmapVoteTotals: [],
    })

    const result = await runHandler(vote, ctx, { featureKey: VOTABLE, deviceToken: DEVICE })

    expect(result).toEqual({ accepted: false, voted: false, remaining: 0 })
    expect(ctx.tables.roadmapVotes).toHaveLength(3)
  })

  it('trips the feature breaker before inserting', async () => {
    const ctx = createConvexCtx({
      roadmapVotes: [],
      roadmapVoteTotals: [
        { _id: 'total_guest', featureKey: VOTABLE, total: FEATURE_TOTAL_BREAKER },
      ],
    })

    await expect(
      runHandler(vote, ctx, { featureKey: VOTABLE, deviceToken: DEVICE })
    ).rejects.toThrow(/Límite de solicitudes/)
    expect(ctx.tables.roadmapVotes).toEqual([])
  })
})

describe('roadmap.submitFeatureRequest', () => {
  it('rejects an empty body after normalization', async () => {
    const ctx = createConvexCtx({ roadmapFeatureRequests: [] })

    await expect(
      runHandler(submitFeatureRequest, ctx, {
        body: '   \n\t  ',
        locale: 'es',
        deviceToken: DEVICE,
      })
    ).rejects.toThrow(/Escribe tu petición/)
  })

  it('stores a new request and reports an exact duplicate', async () => {
    const ctx = createConvexCtx({ roadmapFeatureRequests: [] })
    const args = {
      body: 'Quiero exportar el roadmap a excel',
      locale: 'es' as const,
      deviceToken: DEVICE,
    }

    const first = await runHandler(submitFeatureRequest, ctx, args)
    const second = await runHandler(submitFeatureRequest, ctx, {
      ...args,
      body: 'Necesito por favor exportar el roadmap a excel',
    })

    expect(first).toEqual({ stored: true, duplicate: false })
    expect(second).toEqual({ stored: false, duplicate: true })
    expect(ctx.tables.roadmapFeatureRequests).toHaveLength(1)
  })

  it('allows a dismissed duplicate to be stored again', async () => {
    const ctx = createConvexCtx({
      roadmapFeatureRequests: [
        {
          _id: 'req_old',
          body: 'exportar roadmap',
          normalizedBody: 'exportar roadmap',
          locale: 'es',
          deviceToken: OTHER_DEVICE,
          status: 'DISMISSED',
          createdAt: Date.now(),
        },
      ],
    })

    const result = await runHandler(submitFeatureRequest, ctx, {
      body: 'exportar roadmap',
      locale: 'es',
      deviceToken: DEVICE,
    })

    expect(result).toEqual({ stored: true, duplicate: false })
    expect(ctx.tables.roadmapFeatureRequests).toHaveLength(2)
  })

  it('caps a device at five requests inside 24 hours', async () => {
    const now = Date.now()
    const ctx = createConvexCtx({
      roadmapFeatureRequests: Array.from({ length: REQUESTS_PER_DEVICE_PER_DAY }, (_, index) => ({
        _id: `req_${index}`,
        _creationTime: now - index,
        body: `peticion ${index}`,
        normalizedBody: `peticion ${index}`,
        locale: 'es',
        deviceToken: DEVICE,
        status: 'NEW',
        createdAt: now - index * 1000,
      })),
    })

    await expect(
      runHandler(submitFeatureRequest, ctx, {
        body: 'una sexta peticion distinta',
        locale: 'es',
        deviceToken: DEVICE,
      })
    ).rejects.toThrow(/varias peticiones hoy/)
  })

  it('trips the global NEW-request breaker', async () => {
    const ctx = createConvexCtx({
      roadmapFeatureRequests: Array.from({ length: REQUESTS_GLOBAL_BREAKER }, (_, index) => ({
        _id: `queued_${index}`,
        body: `cola ${index}`,
        normalizedBody: `cola ${index}`,
        locale: 'es',
        deviceToken: OTHER_DEVICE,
        status: 'NEW',
        createdAt: 1,
      })),
    })

    await expect(
      runHandler(submitFeatureRequest, ctx, {
        body: 'otra peticion cuando la cola esta llena',
        locale: 'es',
        deviceToken: DEVICE,
      })
    ).rejects.toThrow(/Límite de solicitudes/)
  })
})
