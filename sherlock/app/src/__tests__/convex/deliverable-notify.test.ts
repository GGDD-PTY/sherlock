import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Doc, Id } from '../../../convex/_generated/dataModel'
import type { MutationCtx } from '../../../convex/_generated/server'
import { createConvexCtx, type Tables } from './nda-convex-harness'

const sendProductEmail = vi.fn(async (_ctx: unknown, _args: unknown): Promise<void> => undefined)
vi.mock('../../../convex/email', () => ({
  sendProductEmail: (ctx: unknown, args: unknown) => sendProductEmail(ctx, args),
}))

import {
  deliverableNotificationCopy,
  notifyDeliverablePublished,
} from '../../../convex/_notifications/deliverables'

const COMPANY = {
  _id: 'company_sampleenergy' as Id<'companies'>,
  ownerId: 'profile_owner' as Id<'profiles'>,
  name: 'Sample Hydro, S.A.',
} as unknown as Doc<'companies'>
const VERSION = 'version_1' as Id<'documentVersions'>
const DOCUMENT = 'document_1' as Id<'documents'>

describe('notifyDeliverablePublished', () => {
  let tables: Tables
  let ctx: MutationCtx

  beforeEach(() => {
    sendProductEmail.mockClear()
    tables = { notifications: [] }
    ctx = createConvexCtx(tables) as unknown as MutationCtx
  })

  it('opens one bell for the company owner with the name, label and team note, and emails the entry link', async () => {
    await notifyDeliverablePublished(ctx, {
      company: COMPANY,
      documentId: DOCUMENT,
      versionId: VERSION,
      name: 'Modelo financiero',
      label: 'v1',
      note: 'Primera versión para revisar en la llamada.',
    })

    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({
      userId: 'profile_owner',
      type: 'document_shared',
      title: 'Nuevo en tu sala',
      message: 'El equipo publicó un documento en tu sala. Ábrelo para revisarlo.',
      link: '/my-company/documents?source=document_1:version_1',
      isRead: false,
      entityType: 'document_version',
      entityId: VERSION,
    })
    expect(sendProductEmail).toHaveBeenCalledWith(ctx, {
      recipientProfileId: 'profile_owner',
      event: 'deliverable_published',
    })
  })

  it('does not repeat the bell or the email for the same version', async () => {
    const args = { company: COMPANY, documentId: DOCUMENT, versionId: VERSION, name: 'Teaser' }
    const first = await notifyDeliverablePublished(ctx, args)
    const second = await notifyDeliverablePublished(ctx, args)

    expect([first, second]).toEqual(['created', 'skipped'])
    expect(tables.notifications).toHaveLength(1)
    expect(sendProductEmail).toHaveBeenCalledTimes(1)
  })

  // La dedupe es por versión: cuando el sello llega con la nota después de un
  // push que avisó sin ella, la fila de esa versión se refresca en sitio y
  // vuelve a no leída. El correo de esa versión ya salió y no se repite.
  it('refreshes the bell of an already announced version: new message, unread again, one email', async () => {
    const args = { company: COMPANY, documentId: DOCUMENT, versionId: VERSION, name: 'Teaser' }
    const created = await notifyDeliverablePublished(ctx, args)
    const noticeId = tables.notifications[0]._id
    tables.notifications[0].isRead = true

    const refreshed = await notifyDeliverablePublished(ctx, {
      ...args,
      note: 'Listo para la llamada.',
    })
    const skipped = await notifyDeliverablePublished(ctx, {
      ...args,
      note: 'Listo para la llamada.',
    })

    expect([created, refreshed, skipped]).toEqual(['created', 'refreshed', 'skipped'])
    expect(tables.notifications).toHaveLength(1)
    expect(tables.notifications[0]).toMatchObject({
      _id: noticeId,
      title: 'Nuevo en tu sala',
      message: 'El equipo publicó un documento en tu sala. Ábrelo para revisarlo.',
      isRead: false,
      entityId: VERSION,
    })
    expect(tables.notifications[0].message).not.toContain('Teaser')
    expect(tables.notifications[0].message).not.toContain('Listo para la llamada')
    expect(sendProductEmail).toHaveBeenCalledTimes(1)
  })

  it('does not copy the document name or the team note into the bell', () => {
    const copy = deliverableNotificationCopy({
      name: 'CIM',
      label: 'v1',
      note: 'Primera versión para revisar en la llamada.',
    })

    expect(copy).toEqual({
      title: 'Nuevo en tu sala',
      message: 'El equipo publicó un documento en tu sala. Ábrelo para revisarlo.',
    })
    expect(`${copy.title} ${copy.message}`).not.toContain('CIM')
    expect(`${copy.title} ${copy.message}`).not.toContain('Primera versión')
  })
})
