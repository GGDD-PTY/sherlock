import { beforeEach, describe, expect, it } from 'vitest'
import type { EmailEvent, EmailId } from '@convex-dev/resend'
import type { MutationCtx } from '../../../convex/_generated/server'
import {
  EMAIL_FAILURE_ENTITY,
  EMAIL_FAILURE_LINK,
  recordEmailFailure,
} from '../../../convex/_notifications/emailEvents'

type Row = Record<string, unknown> & { _id: string }

function createCtx(profiles: Row[]) {
  const tables: Record<string, Row[]> = { profiles, notifications: [] }
  let sequence = 0

  function builder(table: string) {
    let rows = [...tables[table]]
    const eqs: Array<[string, unknown]> = []
    const chain = {
      withIndex(_name: string, apply: (q: unknown) => unknown) {
        const q = { eq: (field: string, value: unknown) => (eqs.push([field, value]), q) }
        apply(q)
        rows = rows.filter((row) => eqs.every(([field, value]) => row[field] === value))
        return chain
      },
      filter(apply: (q: unknown) => unknown) {
        const q = {
          field: (name: string) => name,
          eq: (field: string, value: unknown) => (row: Row) => row[field] === value,
        }
        const predicate = apply(q) as (row: Row) => boolean
        rows = rows.filter(predicate)
        return chain
      },
      async first() {
        return rows[0] ?? null
      },
      async take(n: number) {
        return rows.slice(0, n)
      },
      async collect() {
        return rows
      },
    }
    return chain
  }

  const ctx = {
    db: {
      query: (table: string) => builder(table),
      async insert(table: string, value: Record<string, unknown>) {
        const _id = `${table}_${++sequence}`
        tables[table].push({ ...value, _id })
        return _id
      },
    },
  }
  return { ctx: ctx as unknown as MutationCtx, notifications: tables.notifications }
}

const EMAIL_ID = 'kd5884e258037523a2b5fcd529d4f00f' as EmailId
const ADMINS: Row[] = [
  { _id: 'profile_admin_1', role: 'ADMIN', isActive: true },
  { _id: 'profile_admin_2', role: 'ADMIN', isActive: undefined },
  { _id: 'profile_admin_off', role: 'ADMIN', isActive: false },
  { _id: 'profile_company', role: 'COMPANY', isActive: true },
]

function event(type: EmailEvent['type'], extra: Record<string, unknown> = {}): EmailEvent {
  return {
    type,
    created_at: '2026-09-02T20:13:23.000Z',
    data: {
      created_at: '2026-09-02T20:13:19.000Z',
      email_id: '01a063c1-3a43-77ef-bcbc-bb8b2bc89da0',
      from: 'Sherlock <fixture-0e5eb7f8@example.com>',
      to: ['fixture-cffeaf6c@example.com'],
      subject: 'Documentos nuevos de Sample Hydro, S.A.',
      ...extra,
    },
  } as EmailEvent
}

describe('recordEmailFailure', () => {
  let ctx: MutationCtx
  let notifications: Row[]

  beforeEach(() => {
    ;({ ctx, notifications } = createCtx(ADMINS))
  })

  it('turns a bounce into one notification per live admin, with recipient, subject and reason', async () => {
    await recordEmailFailure(ctx, {
      id: EMAIL_ID,
      event: event('email.bounced', {
        bounce: { type: 'Permanent', subType: 'General', message: 'mailbox does not exist' },
      }),
    })

    expect(notifications.map((row) => row.userId)).toEqual(['profile_admin_1', 'profile_admin_2'])
    expect(notifications[0]).toMatchObject({
      type: 'system',
      title: 'Rebotó un correo a fixture-cffeaf6c@example.com',
      link: EMAIL_FAILURE_LINK,
      isRead: false,
      entityType: EMAIL_FAILURE_ENTITY,
      entityId: `${EMAIL_ID}:email.bounced`,
    })
    expect(notifications[0].message).toContain('Documentos nuevos de Sample Hydro, S.A.')
    expect(notifications[0].message).toContain('mailbox does not exist')
  })

  it('names the complaint and the failure reason', async () => {
    await recordEmailFailure(ctx, { id: EMAIL_ID, event: event('email.complained') })
    await recordEmailFailure(ctx, {
      id: EMAIL_ID,
      event: event('email.failed', { failed: { reason: 'domain not verified' } }),
    })

    const titles = notifications.map((row) => row.title)
    expect(titles).toContain('fixture-cffeaf6c@example.com marcó un correo como spam')
    expect(titles).toContain('Falló el envío a fixture-cffeaf6c@example.com')
    expect(notifications.at(-1)?.message).toContain('domain not verified')
  })

  it('ignores every event that is not a failure', async () => {
    for (const type of [
      'email.sent',
      'email.delivered',
      'email.opened',
      'email.clicked',
    ] as const) {
      await recordEmailFailure(ctx, { id: EMAIL_ID, event: event(type) })
    }

    expect(notifications).toEqual([])
  })

  it('does not open a second notification when Resend retries the same event', async () => {
    const bounced = event('email.bounced', {
      bounce: { type: 'Permanent', subType: 'General', message: 'x' },
    })
    await recordEmailFailure(ctx, { id: EMAIL_ID, event: bounced })
    await recordEmailFailure(ctx, { id: EMAIL_ID, event: bounced })

    expect(notifications).toHaveLength(2)
  })
})
