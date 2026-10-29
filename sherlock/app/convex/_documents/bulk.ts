import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from '../_generated/dataModel'
import { mutation, type MutationCtx } from '../_generated/server'
import { requireAuthEffect } from '../_helpers/auth.identity'
import { logAdminAction } from '../_helpers/auditLog'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import type { AppError } from '../_helpers/errors'
import { invalidState, notFound, unauthorized, validationFailed } from '../_helpers/errors'
import { enforceRateLimit } from '../_helpers/rateLimit'
import { inferDocumentClassification } from './policy'
import {
  DELIVERED_RENDITION_MESSAGE,
  findDeliverableBackedByDocuments,
  loadCompletedDeliverablesEffect,
} from './purge'
import {
  recordClientWithdrawalActivityEffect,
  withdrawRenditionsForDocumentsEffect,
} from '../_deliverables/clientWithdrawal'
import { notifyTeamDeliverableWithdrawnEffect } from '../_notifications/deliverables'
import {
  DEFAULT_DOCUMENT_FOLDER,
  loadCompanyOrThrowEffect,
  recordDocumentFolderChangeEffect,
  requireCompanyOwnerOrAdminEffect,
  revokeGrantsForDocumentEffect,
  validateVdrShellFolderDestination,
} from './shared'
import {
  adminVdrCapabilityValidator,
  requireAdminVdrCapability,
  withoutAdminVdrCapability,
} from '../_adminVdr/capability'
import { adminVdrTarget } from '../_adminVdr/capabilityFormat'

const MAX_BULK_DOCUMENTS = 50

const accessLevelValidator = v.union(
  v.literal('PUBLIC'),
  v.literal('NDA_REQUIRED'),
  v.literal('PRIVATE')
)

const classificationValidator = v.union(
  v.literal('PUBLIC_TEASER'),
  v.literal('CONFIDENTIAL'),
  v.literal('RESTRICTED'),
  v.literal('LEGAL'),
  v.literal('KYC_SENSITIVE')
)

type Disclosure = {
  accessLevel: Doc<'documents'>['accessLevel']
  classification: Doc<'documents'>['classification']
}

function validateDisclosure(disclosure: Disclosure): void {
  const { accessLevel, classification } = disclosure
  const compatible =
    accessLevel === 'PUBLIC'
      ? classification === 'PUBLIC_TEASER'
      : classification !== undefined && classification !== 'PUBLIC_TEASER'

  if (!compatible) {
    throw validationFailed(
      accessLevel === 'PUBLIC'
        ? 'El acceso teaser solo es compatible con la clasificación Public teaser.'
        : 'Los documentos protegidos no pueden conservar la clasificación Public teaser.',
      'classification'
    )
  }
}

function validateDocumentIds(documentIds: Id<'documents'>[]): void {
  if (documentIds.length === 0 || documentIds.length > MAX_BULK_DOCUMENTS) {
    throw validationFailed(
      `Selecciona entre 1 y ${MAX_BULK_DOCUMENTS} documentos por operación.`,
      'documentIds'
    )
  }
  if (new Set(documentIds).size !== documentIds.length) {
    throw validationFailed('La selección contiene documentos duplicados.', 'documentIds')
  }
}

const recordActivity = Effect.fn('DocumentBulk.recordActivity')(function* (
  ctx: MutationCtx,
  profileId: Id<'profiles'>,
  document: Doc<'documents'>,
  action: string,
  operation: string,
  previousValue: Record<string, unknown>,
  newValue: Record<string, unknown>
) {
  yield* convexPromise(() =>
    ctx.db.insert('activityLogs', {
      userId: profileId,
      action,
      entityType: 'DOCUMENT',
      entityId: `${document._id}`,
      metadata: {
        resourceType: 'COMPANY',
        resourceId: `${document.companyId}`,
        operation,
        previousValue,
        newValue,
      },
    })
  )
})

type BulkOperation =
  | { type: 'ARCHIVE' }
  | { type: 'MOVE_FOLDER'; folder: string }
  | {
      type: 'CHANGE_DISCLOSURE'
      accessLevel: NonNullable<Doc<'documents'>['accessLevel']>
      classification: NonNullable<Doc<'documents'>['classification']>
    }

type BulkUpdateArgs = {
  adminCapability?: string
  companyId: Id<'companies'>
  documentIds: Id<'documents'>[]
  operation: BulkOperation
}

const bulkUpdateProgram = Effect.fn('DocumentBulk.update')(function* (
  ctx: MutationCtx,
  args: BulkUpdateArgs
): Effect.fn.Return<
  { updated: number; revokedGrants: number; legalHoldsPreserved: number },
  AppError
> {
  const auth = yield* requireAuthEffect(ctx)
  const { user, profile } = auth
  yield* convexSync(() => validateDocumentIds(args.documentIds))

  const company = yield* loadCompanyOrThrowEffect(ctx, args.companyId)
  yield* requireCompanyOwnerOrAdminEffect(
    ctx,
    auth,
    company,
    'Solo el dueño de la empresa puede actualizar documentos en lote.'
  )
  yield* convexPromise(() =>
    requireAdminVdrCapability({
      ctx,
      auth,
      capability: args.adminCapability,
      company,
      action: 'DOCUMENT_BULK_UPDATE',
      target: adminVdrTarget('COMPANY', `${args.companyId}`),
      input: withoutAdminVdrCapability(args),
    })
  )
  yield* convexPromise(() =>
    enforceRateLimit(ctx, {
      key: `documentBulkUpdate:${profile._id}`,
      limit: 30,
      windowMs: 60 * 60 * 1000,
    })
  )

  const operation = args.operation
  const destinationFolder =
    operation.type === 'MOVE_FOLDER'
      ? yield* convexSync(() => validateVdrShellFolderDestination(operation.folder))
      : undefined
  if (operation.type === 'CHANGE_DISCLOSURE') {
    yield* convexSync(() => validateDisclosure(operation))
  }

  // Preflight completo antes de la primera escritura de negocio. Convex
  // ejecuta la mutation como una transacción, pero mantener esta separación
  // evita descubrir un scope mezclado a mitad de la operación.
  const loaded = yield* convexPromise(() =>
    Promise.all(args.documentIds.map((documentId) => ctx.db.get(documentId)))
  )
  // El lote validado se arma aquí en vez de castear después. El
  // `documents as Doc<'documents'>[]` que había antes repetía a mano la promesa
  // que este bucle ya prueba, y sobrevivía a cualquier cambio de la validación.
  const documents: Doc<'documents'>[] = []
  for (let index = 0; index < loaded.length; index += 1) {
    const document = loaded[index]
    const documentId = args.documentIds[index]
    if (!document) return yield* Effect.fail(notFound('Documento', documentId))
    if (document.companyId !== args.companyId) {
      return yield* Effect.fail(
        unauthorized('Todos los documentos deben pertenecer a la misma empresa.')
      )
    }
    if (document.lifecycleStatus === 'ARCHIVED') {
      return yield* Effect.fail(
        invalidState(
          'La selección contiene un documento que ya está archivado.',
          'DOCUMENT_ALREADY_ARCHIVED'
        )
      )
    }
    if (operation.type === 'CHANGE_DISCLOSURE' && document.lifecycleStatus === 'QUARANTINED') {
      return yield* Effect.fail(
        invalidState(
          'No puedes cambiar el disclosure de un archivo en cuarentena.',
          'DOCUMENT_QUARANTINED'
        )
      )
    }
    documents.push(document)
  }

  const heldDocumentIds = new Set<Id<'documents'>>()
  let completedDeliverables: readonly Doc<'deliverables'>[] = []
  let backsCompletedDeliverable = false
  if (operation.type === 'ARCHIVE') {
    // Archivar en lote es el mismo gesto que archivar de a uno
    // (`Documents.archive`) desde la misma barra de la sala, así que responde
    // igual: el dueño quita de su sala lo que quiera, incluida una entrega del
    // equipo, y el retiro se registra y se avisa ([F] 2026-09-17). El ADMIN con
    // capability sigue rechazado con el mensaje de `./purge`, y el lote entero
    // muere antes de la primera escritura para que la sala quede como estaba.
    completedDeliverables = yield* loadCompletedDeliverablesEffect(ctx, args.companyId)
    const selected = new Set(documents.map((document) => `${document._id}`))
    backsCompletedDeliverable = Boolean(
      findDeliverableBackedByDocuments(completedDeliverables, selected)
    )
    if (backsCompletedDeliverable && profile.role === 'ADMIN') {
      return yield* Effect.fail(validationFailed(DELIVERED_RENDITION_MESSAGE, 'documentIds'))
    }

    const holds = yield* convexPromise(() =>
      Promise.all(
        documents.map((document) =>
          ctx.db
            .query('documentLegalHolds')
            .withIndex('by_document_status', (q) =>
              q.eq('documentId', document._id).eq('status', 'ACTIVE')
            )
            .first()
        )
      )
    )
    for (const hold of holds) {
      if (hold) heldDocumentIds.add(hold.documentId)
    }
  }

  let revokedGrants = 0
  let legalHoldsPreserved = 0
  const now = Date.now()

  for (const document of documents) {
    if (operation.type === 'ARCHIVE') {
      if (heldDocumentIds.has(document._id)) legalHoldsPreserved += 1

      revokedGrants += yield* revokeGrantsForDocumentEffect(
        ctx,
        document._id,
        'DOCUMENT_ARCHIVED',
        now
      )
      if (document.currentVersionId) {
        const currentVersionId = document.currentVersionId
        const currentVersion = yield* convexPromise(() => ctx.db.get(currentVersionId))
        if (currentVersion?.documentId === document._id) {
          yield* convexPromise(() =>
            ctx.db.patch(currentVersion._id, { publicationStatus: 'ARCHIVED' })
          )
        }
      }
      const newValue = { lifecycleStatus: 'ARCHIVED' as const, archivedAt: now }
      yield* convexPromise(() =>
        ctx.db.patch(document._id, {
          ...newValue,
          archivedByProfileId: profile._id,
          updatedAt: now,
          protectionPolicyVersion: 'trust-os-v2',
        })
      )
      yield* recordActivity(
        ctx,
        profile._id,
        document,
        'VDR_DOCUMENT_ARCHIVED',
        'ARCHIVE',
        { lifecycleStatus: document.lifecycleStatus ?? 'ACTIVE' },
        newValue
      )
      if (profile.role === 'ADMIN') {
        yield* convexPromise(() =>
          logAdminAction({
            ctx,
            adminProfileId: profile._id,
            adminEmail: user.email,
            action: 'DOCUMENT_ARCHIVE',
            targetType: 'DOCUMENT',
            targetId: `${document._id}`,
            previousValue: { lifecycleStatus: document.lifecycleStatus ?? 'ACTIVE' },
            newValue,
          })
        )
      }
      continue
    }

    if (operation.type === 'MOVE_FOLDER') {
      const nextFolder = destinationFolder
      if (nextFolder === undefined) {
        return yield* Effect.fail(invalidState('No se resolvió la carpeta de destino.', 'folder'))
      }
      const previousFolder = document.folder
      const previousValue = { folder: previousFolder ?? DEFAULT_DOCUMENT_FOLDER }
      const newValue = { folder: nextFolder }
      yield* convexPromise(() =>
        ctx.db.patch(document._id, {
          folder: nextFolder,
          updatedAt: now,
          protectionPolicyVersion: 'trust-os-v2',
        })
      )
      yield* recordDocumentFolderChangeEffect(ctx, {
        profileId: profile._id,
        document,
        previousFolder,
        nextFolder,
      })
      if (profile.role === 'ADMIN') {
        yield* convexPromise(() =>
          logAdminAction({
            ctx,
            adminProfileId: profile._id,
            adminEmail: user.email,
            action: 'DOCUMENT_METADATA_UPDATE',
            targetType: 'DOCUMENT',
            targetId: `${document._id}`,
            previousValue,
            newValue,
          })
        )
      }
      continue
    }

    const previousValue = {
      accessLevel: document.accessLevel ?? 'NDA_REQUIRED',
      classification: inferDocumentClassification(document.accessLevel, document.classification),
    }
    const newValue = {
      accessLevel: operation.accessLevel,
      classification: operation.classification,
    }
    const disclosureChanged =
      previousValue.accessLevel !== newValue.accessLevel ||
      previousValue.classification !== newValue.classification
    if (disclosureChanged) {
      revokedGrants += yield* revokeGrantsForDocumentEffect(
        ctx,
        document._id,
        'DOCUMENT_DISCLOSURE_CHANGED',
        now
      )
    }
    yield* convexPromise(() =>
      ctx.db.patch(document._id, {
        ...newValue,
        updatedAt: now,
        protectionPolicyVersion: 'trust-os-v2',
      })
    )
    yield* recordActivity(
      ctx,
      profile._id,
      document,
      'VDR_DOCUMENT_DISCLOSURE_CHANGED',
      'CHANGE_DISCLOSURE',
      previousValue,
      newValue
    )
    if (profile.role === 'ADMIN') {
      yield* convexPromise(() =>
        logAdminAction({
          ctx,
          adminProfileId: profile._id,
          adminEmail: user.email,
          action: 'DOCUMENT_METADATA_UPDATE',
          targetType: 'DOCUMENT',
          targetId: `${document._id}`,
          previousValue,
          newValue,
        })
      )
    }
  }

  // El lote entero se resuelve en UNA pasada por los entregables: dos
  // documentos del mismo slot (el PPTX y el PDF de la misma presentación)
  // tienen que dejar un solo patch y un solo aviso, no uno por archivo.
  if (backsCompletedDeliverable) {
    const withdrawals = yield* withdrawRenditionsForDocumentsEffect(ctx, {
      completed: completedDeliverables,
      documentIds: new Set(documents.map((document) => `${document._id}`)),
      profileId: profile._id,
      now,
    })
    yield* recordClientWithdrawalActivityEffect(ctx, {
      companyId: args.companyId,
      profileId: profile._id,
      withdrawals,
    })
    const withdrawnDocumentIds = new Set(
      withdrawals.flatMap((withdrawal) =>
        withdrawal.documentIds.map((documentId) => `${documentId}`)
      )
    )
    yield* notifyTeamDeliverableWithdrawnEffect(ctx, {
      company,
      documentNames: documents
        .filter((document) => withdrawnDocumentIds.has(`${document._id}`))
        .map((document) => document.name),
      withdrawals,
    })
  }

  return { updated: documents.length, revokedGrants, legalHoldsPreserved }
})

export const bulkUpdate = mutation({
  args: {
    adminCapability: adminVdrCapabilityValidator,
    companyId: v.id('companies'),
    documentIds: v.array(v.id('documents')),
    operation: v.union(
      v.object({ type: v.literal('ARCHIVE') }),
      v.object({ type: v.literal('MOVE_FOLDER'), folder: v.string() }),
      v.object({
        type: v.literal('CHANGE_DISCLOSURE'),
        accessLevel: accessLevelValidator,
        classification: classificationValidator,
      })
    ),
  },
  handler: (ctx, args) => runConvex(bulkUpdateProgram(ctx, args)),
})
