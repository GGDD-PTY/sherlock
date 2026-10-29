// ============================================================================
// RESTAURAR LO QUE EL OPERADOR ARCHIVÓ O RENOMBRÓ
// ============================================================================
// `documents:remove` (`_documents/mutations.ts`) archiva y no tenía vuelta:
// pone `lifecycleStatus: 'ARCHIVED'`, sella `archivedAt`/`archivedByProfileId`,
// baja la versión vigente a `ARCHIVED` y revoca los grants. Ninguna mutation
// deshacía nada de eso. Este módulo restaura documentos archivados por el
// operador y permite corregir el nombre de una sala con confirmación explícita.
//
// `convex run` no ejecuta código inline: solo `--inline-query`. Por eso la
// vuelta tiene que existir como mutation con nombre, no como script.
//
// CONTROL DE ACCESO: `internalMutation`, alcanzable solo con la deploy key del
// deployment — igual que `operatorPurge.ts`, y por la misma razón: el nombre de
// la empresa lo ve su propio dueño en pantalla, así que `confirmCompanyName` /
// `confirmCurrentName` son oráculos humanos, no compuertas de rol. Quien no
// sabe escribir el nombre no estaba mirando la sala que va a tocar.
//
// LO QUE NO HACE: no recrea los grants que el archivado revocó. Un grant es
// acceso vivo de un tercero; resucitarlo sería repartir acceso que hoy nadie
// pidió. Quien lo necesite lo vuelve a pedir por la sala. Tampoco toca bytes,
// hashes ni versiones anteriores: la restauración es de estado, no de contenido.
//
// EFFECT: el cuerpo de las dos mutations vive en un programa con nombre y cruza
// a Convex por la costura única (`_helpers/effect.ts`), igual que
// `operatorPurge.ts`. Todo lo que toca `ctx.db` pasa por `convexPromise`, cada
// fallo de negocio viaja por el canal de error como `AppError` en vez de
// lanzarse, y el registro de Convex queda en una línea: `runConvex(programa)`.
// ============================================================================

import { v } from 'convex/values'
import { Effect } from 'effect'

import type { Doc, Id } from './_generated/dataModel'
import { internalMutation, type MutationCtx } from './_generated/server'
import { logAdminAction } from './_helpers/auditLog'
import { COMPANY_NAME_MAX_LENGTH, normalizeCompanyName } from './_helpers/companyName'
import { convexPromise, runConvex } from './_helpers/effect'
import { notFound, validationFailed } from './_helpers/errors'

/** Mismo sello que escribe `documents:remove` al archivar: la fila queda en la
 *  política vigente, no en la que tenía antes del archivado. */
const PROTECTION_POLICY_VERSION = 'trust-os-v2'

const restoreArchivedDocumentsProgram = Effect.fn('OperatorRestore.restoreArchivedDocuments')(
  function* (
    ctx: MutationCtx,
    args: {
      companyId: Id<'companies'>
      documentIds: Array<Id<'documents'>>
      operatorProfileId: Id<'profiles'>
      confirmCompanyName: string
      reason: string
    }
  ) {
    const reason = args.reason.trim()
    if (!reason) {
      return yield* Effect.fail(
        validationFailed('La razón de la restauración es obligatoria.', 'reason')
      )
    }

    // `logAdminAction` exige un ADMIN real con su email; una internalMutation no
    // tiene sesión, así que el operador se nombra explícito y se verifica contra
    // la tabla — la misma forma que `operatorPurge:deleteDocumentsHard`.
    const operator = yield* convexPromise(() => ctx.db.get(args.operatorProfileId))
    if (!operator || operator.role !== 'ADMIN') {
      return yield* Effect.fail(
        validationFailed('operatorProfileId debe identificar un perfil ADMIN real.')
      )
    }
    if (operator.isActive === false) {
      return yield* Effect.fail(validationFailed('El perfil ADMIN operador debe estar activo.'))
    }
    const operatorUser = yield* convexPromise(() => ctx.db.get(operator.userId))
    if (!operatorUser) {
      return yield* Effect.fail(notFound('Usuario del operador ADMIN', operator.userId))
    }

    const company = yield* convexPromise(() => ctx.db.get(args.companyId))
    if (!company) return yield* Effect.fail(notFound('Company', args.companyId))
    if (args.confirmCompanyName !== company.name) {
      return yield* Effect.fail(
        validationFailed(
          `confirmCompanyName no coincide con el nombre de la empresa. Escribe exactamente: ${company.name}`
        )
      )
    }

    if (args.documentIds.length === 0) {
      return yield* Effect.fail(
        validationFailed('documentIds no puede venir vacío.', 'documentIds')
      )
    }
    const distinct = new Set(args.documentIds)
    if (distinct.size !== args.documentIds.length) {
      return yield* Effect.fail(
        validationFailed('documentIds contiene ids duplicados.', 'documentIds')
      )
    }

    // El lote entero se valida ANTES de escribir: una restauración a medias deja
    // la sala en un estado que nadie pidió y que el recibo no describe.
    const documents: Doc<'documents'>[] = []
    const missing: string[] = []
    const foreign: string[] = []
    const notArchived: string[] = []
    for (const documentId of args.documentIds) {
      const document = yield* convexPromise(() => ctx.db.get(documentId))
      if (!document) {
        missing.push(documentId)
        continue
      }
      if (document.companyId !== args.companyId) {
        foreign.push(documentId)
        continue
      }
      if (document.lifecycleStatus !== 'ARCHIVED') {
        notArchived.push(`${documentId} (${document.lifecycleStatus ?? 'ACTIVE'})`)
        continue
      }
      documents.push(document)
    }

    const offenders = [
      missing.length > 0 ? `inexistentes: ${missing.join(', ')}` : null,
      foreign.length > 0 ? `de otra empresa: ${foreign.join(', ')}` : null,
      notArchived.length > 0 ? `no archivados: ${notArchived.join(', ')}` : null,
    ].filter((part): part is string => part !== null)
    if (offenders.length > 0) {
      return yield* Effect.fail(
        validationFailed(
          `El lote no se restauró (${offenders.join(' | ')}); ningún documento cambió.`,
          'documentIds'
        )
      )
    }

    const now = Date.now()
    const previousDocuments: Array<{
      id: string
      name: string
      lifecycleStatus: string
      archivedAt: number | null
    }> = []
    let versionsPublished = 0

    for (const document of documents) {
      previousDocuments.push({
        id: document._id,
        name: document.name,
        lifecycleStatus: 'ARCHIVED',
        archivedAt: document.archivedAt ?? null,
      })

      // Solo la versión vigente y solo si el archivado fue quien la bajó: una
      // versión en DRAFT o SUPERSEDED se quedó así por otra razón.
      if (document.currentVersionId) {
        const currentVersionId = document.currentVersionId
        const currentVersion = yield* convexPromise(() => ctx.db.get(currentVersionId))
        if (
          currentVersion?.documentId === document._id &&
          currentVersion.publicationStatus === 'ARCHIVED'
        ) {
          yield* convexPromise(() =>
            ctx.db.patch(currentVersion._id, { publicationStatus: 'PUBLISHED' })
          )
          versionsPublished += 1
        }
      }

      // `undefined` BORRA la clave en Convex: el sello del archivado se va, no
      // se queda en cero.
      yield* convexPromise(() =>
        ctx.db.patch(document._id, {
          lifecycleStatus: 'ACTIVE',
          archivedAt: undefined,
          archivedByProfileId: undefined,
          updatedAt: now,
          protectionPolicyVersion: PROTECTION_POLICY_VERSION,
        })
      )

      yield* convexPromise(() =>
        ctx.db.insert('activityLogs', {
          userId: operator._id,
          action: 'VDR_DOCUMENT_RESTORED',
          entityType: 'DOCUMENT',
          entityId: document._id,
          metadata: {
            resourceType: 'COMPANY',
            resourceId: document.companyId,
          },
        })
      )
    }

    const totals = { documents: documents.length, versionsPublished }
    yield* convexPromise(() =>
      logAdminAction({
        ctx,
        adminProfileId: operator._id,
        adminEmail: operatorUser.email,
        action: 'DOCUMENT_RESTORE',
        targetType: 'DOCUMENT',
        targetId: args.documentIds.join(','),
        previousValue: { documents: previousDocuments },
        newValue: { reason, totals },
        notes: reason,
      })
    )

    // `skipped` viaja siempre vacío: la validación es todo-o-nada y un lote con
    // un solo id inválido no llega hasta aquí. Existe para que el recibo del
    // operador tenga una forma estable si mañana se acepta un lote parcial.
    return { restored: documents.length, skipped: [] as string[] }
  }
)

export const restoreArchivedDocuments = internalMutation({
  args: {
    companyId: v.id('companies'),
    documentIds: v.array(v.id('documents')),
    operatorProfileId: v.id('profiles'),
    confirmCompanyName: v.string(),
    reason: v.string(),
  },
  handler: (ctx, args) => runConvex(restoreArchivedDocumentsProgram(ctx, args)),
})

const setCompanyNameProgram = Effect.fn('OperatorRestore.setCompanyName')(function* (
  ctx: MutationCtx,
  args: {
    companyId: Id<'companies'>
    name: string
    legalName?: string
    operatorProfileId: Id<'profiles'>
    confirmCurrentName: string
    reason: string
  }
) {
  const reason = args.reason.trim()
  if (!reason) {
    return yield* Effect.fail(validationFailed('La razón del renombre es obligatoria.', 'reason'))
  }

  const operator = yield* convexPromise(() => ctx.db.get(args.operatorProfileId))
  if (!operator || operator.role !== 'ADMIN') {
    return yield* Effect.fail(
      validationFailed('operatorProfileId debe identificar un perfil ADMIN real.')
    )
  }
  if (operator.isActive === false) {
    return yield* Effect.fail(validationFailed('El perfil ADMIN operador debe estar activo.'))
  }
  const operatorUser = yield* convexPromise(() => ctx.db.get(operator.userId))
  if (!operatorUser) {
    return yield* Effect.fail(notFound('Usuario del operador ADMIN', operator.userId))
  }

  const company = yield* convexPromise(() => ctx.db.get(args.companyId))
  if (!company) return yield* Effect.fail(notFound('Empresa', args.companyId))
  if (args.confirmCurrentName !== company.name) {
    return yield* Effect.fail(
      validationFailed(
        `confirmCurrentName no coincide con el nombre actual de la empresa. Escribe exactamente: ${company.name}`
      )
    )
  }

  // El mismo normalizador que aplica el claim de la landing
  // (`_intake/claim.ts`), para que operador y cliente no tengan dos ideas
  // distintas de "nombre válido".
  const name = normalizeCompanyName(args.name)
  if (!name) {
    return yield* Effect.fail(
      validationFailed(
        `El nombre de la empresa no es válido: revisa que no esté vacío ni pase de ${COMPANY_NAME_MAX_LENGTH} caracteres.`,
        'name'
      )
    )
  }

  let legalName: string | undefined
  if (args.legalName !== undefined) {
    legalName = normalizeCompanyName(args.legalName)
    if (!legalName) {
      return yield* Effect.fail(
        validationFailed(
          `La razón social no es válida: revisa que no esté vacía ni pase de ${COMPANY_NAME_MAX_LENGTH} caracteres.`,
          'legalName'
        )
      )
    }
  }

  const previousValue = { name: company.name, legalName: company.legalName ?? null }
  // `companies` no tiene `updatedAt` en el schema (`schema.ts`): agregarlo en
  // el patch lo rechazaría el validador de la tabla. El recibo del cambio es
  // la fila de `adminAuditLogs`.
  yield* convexPromise(() =>
    ctx.db.patch(args.companyId, {
      name,
      ...(legalName === undefined ? {} : { legalName }),
    })
  )

  yield* convexPromise(() =>
    logAdminAction({
      ctx,
      adminProfileId: operator._id,
      adminEmail: operatorUser.email,
      action: 'COMPANY_RENAME',
      targetType: 'COMPANY',
      targetId: args.companyId,
      previousValue,
      newValue: { name, legalName: legalName ?? previousValue.legalName, reason },
      notes: reason,
    })
  )

  return { companyId: args.companyId, previousName: previousValue.name, name, legalName }
})

export const setCompanyName = internalMutation({
  args: {
    companyId: v.id('companies'),
    name: v.string(),
    legalName: v.optional(v.string()),
    operatorProfileId: v.id('profiles'),
    confirmCurrentName: v.string(),
    reason: v.string(),
  },
  handler: (ctx, args) => runConvex(setCompanyNameProgram(ctx, args)),
})
