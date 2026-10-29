// ============================================================================
// EMAIL — el timbre saliente (Resend vía componente oficial de Convex)
// ============================================================================
// Enviar se ENCOLA dentro de la misma mutación que crea la notificación in-app:
// el enqueue es transaccional (si la mutación revierte, no sale nada) y el
// componente aporta cola durable, batching, idempotencia y rate limiting.
//
// Fail-open a propósito: sin credencial, remitente u origen el email no sale y la
// campanita in-app sigue siendo la fuente de verdad. Un fallo del email JAMÁS
// tumba la mutación de producto que lo dispara.
//
// Env (deployment de Convex, no .env.local):
//   RESEND_API_KEY     — credencial requerida para el envío
//   RESEND_TEST_MODE   — default true (solo entrega a *@resend.dev);
//                        poner 'false' en prod cuando el dominio esté verificado
//   RESEND_FROM_EMAIL  — remitente verificado obligatorio, sin valor por defecto
//   APP_URL            — origin absoluto obligatorio para los links de entrada
//   Si falta cualquiera de los tres valores, no se encola ningún correo.
//   RESEND_WEBHOOK_SECRET — firma de los eventos que llegan a convex/http.ts;
//                        cada evento pasa por `_recordEmailFailure` (rebotes y quejas
//                        se vuelven campanita del equipo, el resto se ignora)
// ============================================================================

import { Resend } from '@convex-dev/resend'
import { Cause, Effect } from 'effect'

import { components, internal } from './_generated/api'
import type { MutationCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'
import { convexPromise, runConvex, type ConvexEffect } from './_helpers/effect'
import { getEmailConfiguration } from './_helpers/emailConfig'
import { buildProductEmail, type ProductEmailEvent } from './_helpers/emailTemplates'
import {
  buildDeliverableWithdrawnEmail,
  buildServerErrorAlertEmail,
  buildSupportMessageEmail,
  buildTeamAlertEmail,
  type ServerErrorAlertEmailInput,
  type TeamAlertKind,
} from './_helpers/teamEmailTemplates'

export const resend: Resend = new Resend(components.resend, {
  testMode: process.env.RESEND_TEST_MODE !== 'false',
  onEmailEvent: internal.notifications._recordEmailFailure,
})

export function isProductEmailEnabled(): boolean {
  return getEmailConfiguration() !== null
}

/**
 * El fail-open, en un solo lugar y explícito: ningún fallo de correo —error de
 * negocio o defecto nuestro— sale de estas funciones. Se anota SOLO el nombre
 * del error, nunca la causa completa: el mensaje de un fallo de envío puede
 * llevar el correo del destinatario, y estos logs no son el lugar.
 */
function failOpen(label: string) {
  return <A>(program: ConvexEffect<A>): Promise<void> =>
    runConvex(
      program.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => {
          const error = Cause.squash(cause)
          return Effect.logWarning(
            `[EMAIL] Failed to enqueue ${label}; in-app notification remains the source of truth.`,
            error instanceof Error ? error.name : 'UnknownError'
          )
        })
      )
    )
}

/** Resuelve profile → user → email. Si cualquier eslabón falta, no hay destino. */
const resolveRecipientEmail = Effect.fn('Email.resolveRecipient')(function* (
  ctx: MutationCtx,
  recipientProfileId: Id<'profiles'>
) {
  const profile = yield* convexPromise(() => ctx.db.get(recipientProfileId))
  if (!profile) return null

  const user = yield* convexPromise(() => ctx.db.get(profile.userId))
  return user?.email ?? null
})

const enqueue = Effect.fn('Email.enqueue')(function* (
  ctx: MutationCtx,
  to: string,
  message: { subject: string; html: string; text: string }
) {
  const config = getEmailConfiguration()
  if (!config) return
  yield* convexPromise(() =>
    resend.sendEmail(ctx, {
      from: config.from,
      to,
      ...message,
    })
  )
})

const sendProductEmailProgram = Effect.fn('Email.sendProductEmail')(function* (
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    event: ProductEmailEvent
  }
) {
  const to = yield* resolveRecipientEmail(ctx, args.recipientProfileId)
  if (!to) return

  const config = getEmailConfiguration()
  if (!config) return
  const appUrl = config.appOrigin
  const { subject, html, text } = buildProductEmail(args.event, appUrl)

  yield* enqueue(ctx, to, { subject, html, text })
})

/**
 * Encola el correo de un evento de producto para el dueño de un perfil.
 * Resuelve profile → user → email; si cualquier eslabón falta, no envía.
 */
export function sendProductEmail(
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    event: ProductEmailEvent
  }
): Promise<void> {
  if (!isProductEmailEnabled()) {
    return Promise.resolve()
  }

  return failOpen(`${args.event} email`)(sendProductEmailProgram(ctx, args))
}

const sendTeamAlertEmailProgram = Effect.fn('Email.sendTeamAlertEmail')(function* (
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    kind: TeamAlertKind
    companyName: string
    fileCount: number
    folders: string[]
    fileNames: string[]
    link: string
  }
) {
  const to = yield* resolveRecipientEmail(ctx, args.recipientProfileId)
  if (!to) return

  // `link` se guarda sin locale porque la campanita navega con el `Link`
  // localizado. El correo sale del producto, así que acá sí se ancla a `es`.
  const config = getEmailConfiguration()
  if (!config) return
  const appUrl = config.appOrigin
  const { subject, html, text } = buildTeamAlertEmail({
    kind: args.kind,
    companyName: args.companyName,
    fileCount: args.fileCount,
    folders: args.folders,
    fileNames: args.fileNames,
    url: `${appUrl}/es${args.link}`,
  })

  yield* enqueue(ctx, to, { subject, html, text })
})

/**
 * Encola el aviso interno de una tanda de `teamAlerts` para un perfil ADMIN.
 * A diferencia de `sendProductEmail`, este correo sí nombra la empresa y los
 * archivos: el destinatario es el equipo, no una contraparte.
 */
export function sendTeamAlertEmail(
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    kind: TeamAlertKind
    companyName: string
    fileCount: number
    folders: string[]
    fileNames: string[]
    link: string
  }
): Promise<void> {
  if (!isProductEmailEnabled()) {
    return Promise.resolve()
  }

  return failOpen(`${args.kind} team alert`)(sendTeamAlertEmailProgram(ctx, args))
}

const sendSupportMessageEmailProgram = Effect.fn('Email.sendSupportMessageEmail')(function* (
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    companyName: string
    messageCount: number
    link: string
  }
) {
  const to = yield* resolveRecipientEmail(ctx, args.recipientProfileId)
  if (!to) return

  const config = getEmailConfiguration()
  if (!config) return
  const appUrl = config.appOrigin
  const { subject, html, text } = buildSupportMessageEmail({
    companyName: args.companyName,
    messageCount: args.messageCount,
    url: `${appUrl}/es${args.link}`,
  })

  yield* enqueue(ctx, to, { subject, html, text })
})

/**
 * Encola el aviso de que un cliente escribió en «Habla con el equipo», para un
 * perfil ADMIN. Mismo carril que `sendTeamAlertEmail` —mismo guard fail-open,
 * mismo remitente, mismo APP_URL— con una regla propia de la plantilla: el
 * texto del mensaje del cliente no viaja, solo la empresa y el enlace al hilo.
 */
export function sendSupportMessageEmail(
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    companyName: string
    messageCount: number
    link: string
  }
): Promise<void> {
  if (!isProductEmailEnabled()) {
    return Promise.resolve()
  }

  return failOpen('SUPPORT_MESSAGE team alert')(sendSupportMessageEmailProgram(ctx, args))
}

const sendDeliverableWithdrawnEmailProgram = Effect.fn('Email.sendDeliverableWithdrawnEmail')(
  function* (
    ctx: MutationCtx,
    args: {
      recipientProfileId: Id<'profiles'>
      companyName: string
      summary: string
      documentNames: string[]
      link: string
    }
  ) {
    const to = yield* resolveRecipientEmail(ctx, args.recipientProfileId)
    if (!to) return

    const config = getEmailConfiguration()
    if (!config) return
    const appUrl = config.appOrigin
    const { subject, html, text } = buildDeliverableWithdrawnEmail({
      companyName: args.companyName,
      summary: args.summary,
      documentNames: args.documentNames,
      url: `${appUrl}/es${args.link}`,
    })

    yield* enqueue(ctx, to, { subject, html, text })
  }
)

/**
 * Encola el aviso de que el cliente quitó de su sala una entrega del equipo,
 * para un perfil ADMIN. Mismo carril que `sendSupportMessageEmail`: mismo guard
 * fail-open, mismo remitente, mismo APP_URL.
 */
export function sendDeliverableWithdrawnEmail(
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    companyName: string
    summary: string
    documentNames: string[]
    link: string
  }
): Promise<void> {
  if (!isProductEmailEnabled()) {
    return Promise.resolve()
  }

  return failOpen('DELIVERABLE_WITHDRAWN team alert')(
    sendDeliverableWithdrawnEmailProgram(ctx, args)
  )
}

const sendServerErrorAlertEmailProgram = Effect.fn('Email.sendServerErrorAlertEmail')(function* (
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    link: string
  } & Omit<ServerErrorAlertEmailInput, 'url'>
) {
  const to = yield* resolveRecipientEmail(ctx, args.recipientProfileId)
  if (!to) return

  const config = getEmailConfiguration()
  if (!config) return
  const appUrl = config.appOrigin
  const { subject, html, text } = buildServerErrorAlertEmail({
    route: args.route,
    errorName: args.errorName,
    status: args.status,
    message: args.message,
    requestId: args.requestId,
    method: args.method,
    synthetic: args.synthetic,
    digest: args.digest,
    occurrences: args.occurrences,
    suppressedRepeats: args.suppressedRepeats,
    url: `${appUrl}/es${args.link}`,
  })

  yield* enqueue(ctx, to, { subject, html, text })
})

/**
 * Encola la alerta de un 5xx para un perfil ADMIN. Mismo carril que
 * `sendTeamAlertEmail` — mismo guard fail-open, mismo remitente, mismo APP_URL
 * — con su propia plantilla: acá no hay empresa ni archivos, hay una ruta
 * plantilla y un error.
 */
export function sendServerErrorAlertEmail(
  ctx: MutationCtx,
  args: {
    recipientProfileId: Id<'profiles'>
    link: string
  } & Omit<ServerErrorAlertEmailInput, 'url'>
): Promise<void> {
  if (!isProductEmailEnabled()) {
    return Promise.resolve()
  }

  return failOpen('SERVER_ERROR team alert')(sendServerErrorAlertEmailProgram(ctx, args))
}
