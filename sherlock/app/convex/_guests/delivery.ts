import { Effect, Schema } from 'effect'

import type { MutationCtx } from '../_generated/server'
import { convexPromise, convexSync, runConvex } from '../_helpers/effect'
import { invalidState, validationFailed } from '../_helpers/errors'
import { resend } from '../email'
import { getEmailConfiguration } from '../_helpers/emailConfig'
import { hashChallengeToken, hashInvitationHandle, normalizeGuestEmail } from './crypto'
import {
  genericChallengeResponse,
  prepareOtpChallengeForDelivery,
  type GenericOtpChallengeResponse,
} from './service'

// Sin `Schema.Literals`: no hay frontera que decodificar acá y un const que
// solo produce un tipo es un valor muerto en el bundle.
type GuestInvitationLocale = 'es' | 'en'

// El handle que viaja en el fragmento de la URL: una definición para la forma
// que se acuña y para la que se acepta de vuelta.
const InvitationHandle = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[a-zA-Z0-9_-]{32,256}$/))
)
const isInvitationHandle = Schema.is(InvitationHandle)

function guestAppOrigin(): string | null {
  return getEmailConfiguration()?.appOrigin ?? null
}

export function isGuestOtpDeliveryConfigured(): boolean {
  return getEmailConfiguration() !== null
}

export function isGuestInitialInvitationDeliveryConfigured(): boolean {
  return isGuestOtpDeliveryConfigured() && guestAppOrigin() !== null
}

function buildInvitationEmail(input: { invitationHandle: string; locale: GuestInvitationLocale }) {
  const origin = guestAppOrigin()
  if (!origin) {
    throw invalidState(
      'La invitación externa no está disponible temporalmente.',
      'GUEST_APP_URL_NOT_CONFIGURED'
    )
  }
  if (!isInvitationHandle(input.invitationHandle)) {
    throw validationFailed('La invitación no tiene un formato válido.', 'invitationHandle')
  }

  // El bearer vive en el fragmento: navegadores y proxies no lo envían en el
  // request HTTP. La landing lo retira de la barra antes de iniciar el journey.
  const invitationUrl = `${origin}/${input.locale}/vdr-guest#${input.invitationHandle}`
  if (input.locale === 'en') {
    return {
      subject: 'Your secure Sherlock invitation',
      text: [
        'You have been invited to a controlled Sherlock verification journey.',
        '',
        invitationUrl,
        '',
        'The link identifies this invitation. You will still need to confirm your email with a one-time code.',
        'Email verification does not grant access to the data room or its documents.',
        'If you were not expecting this invitation, do not open the link.',
      ].join('\n'),
      html: [
        '<div style="font-family:Arial,sans-serif;color:#0e1a2b;line-height:1.6">',
        '<p>You have been invited to a controlled Sherlock verification journey.</p>',
        `<p><a href="${invitationUrl}" style="display:inline-block;padding:12px 18px;background:#5a2331;color:#f6f3ec;text-decoration:none;border-radius:6px">Continue securely</a></p>`,
        '<p>The link identifies this invitation. You will still need to confirm your email with a one-time code.</p>',
        '<p>Email verification does not grant access to the data room or its documents.</p>',
        '<p>If you were not expecting this invitation, do not open the link.</p>',
        '</div>',
      ].join(''),
    }
  }

  return {
    subject: 'Tu invitación segura a Sherlock',
    text: [
      'Recibiste una invitación a un proceso de verificación controlado en Sherlock.',
      '',
      invitationUrl,
      '',
      'El enlace identifica esta invitación. Aún deberás confirmar tu email con un código de un solo uso.',
      'Verificar tu email no concede acceso a una sala ni a documentos.',
      'Si no esperabas esta invitación, no abras el enlace.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;color:#0e1a2b;line-height:1.6">',
      '<p>Recibiste una invitación a un proceso de verificación controlado en Sherlock.</p>',
      `<p><a href="${invitationUrl}" style="display:inline-block;padding:12px 18px;background:#5a2331;color:#f6f3ec;text-decoration:none;border-radius:6px">Continuar de forma segura</a></p>`,
      '<p>El enlace identifica esta invitación. Aún deberás confirmar tu email con un código de un solo uso.</p>',
      '<p>Verificar tu email no concede acceso a una sala ni a documentos.</p>',
      '<p>Si no esperabas esta invitación, no abras el enlace.</p>',
      '</div>',
    ].join(''),
  }
}

/**
 * Encola el primer email dentro de la mutation que crea la invitación. No se
 * captura el error: Convex debe revertir invitación, memberships, auditoría y
 * enqueue como una sola transacción si el componente rechaza la operación.
 */
const enqueueGuestInvitationDeliveryEffect = Effect.fn('GuestDelivery.enqueueInvitation')(
  function* (
    ctx: MutationCtx,
    input: {
      email: string
      invitationHandle: string
      locale: GuestInvitationLocale
    }
  ) {
    const config = getEmailConfiguration()
    if (!config) {
      yield* Effect.fail(
        invalidState(
          'La invitación externa no está disponible temporalmente.',
          'GUEST_INVITATION_DELIVERY_NOT_CONFIGURED'
        )
      )
      return
    }
    const content = yield* convexSync(() => buildInvitationEmail(input))
    const to = yield* convexSync(() => normalizeGuestEmail(input.email))
    yield* convexPromise(() =>
      resend.sendEmail(ctx, {
        from: config.from,
        to,
        ...content,
      })
    )
  }
)

export async function enqueueGuestInvitationDelivery(
  ctx: MutationCtx,
  input: {
    email: string
    invitationHandle: string
    locale: GuestInvitationLocale
  }
): Promise<void> {
  await runConvex(enqueueGuestInvitationDeliveryEffect(ctx, input))
}

function buildOtpEmail(code: string, locale: GuestInvitationLocale) {
  if (locale === 'en') {
    return {
      subject: 'Your secure Sherlock access code',
      text: [
        'Use this code to verify your email on Sherlock:',
        '',
        code,
        '',
        'The code expires in 10 minutes and can only be used once.',
        'Verifying your email does not grant access to the data room or its documents.',
        'If you did not request this code, ignore this message.',
      ].join('\n'),
      html: [
        '<div style="font-family:Arial,sans-serif;color:#0e1a2b;line-height:1.6">',
        '<p>Use this code to verify your email on Sherlock:</p>',
        `<p style="font-family:monospace;font-size:28px;letter-spacing:0.18em"><strong>${code}</strong></p>`,
        '<p>The code expires in 10 minutes and can only be used once.</p>',
        '<p>Verifying your email does not grant access to the data room or its documents.</p>',
        '<p>If you did not request this code, ignore this message.</p>',
        '</div>',
      ].join(''),
    }
  }

  return {
    subject: 'Tu código de acceso seguro a Sherlock',
    text: [
      'Usa este código para verificar tu email en Sherlock:',
      '',
      code,
      '',
      'El código vence en 10 minutos y solo se puede usar una vez.',
      'Verificar tu email no concede acceso a ningún documento ni sala.',
      'Si no solicitaste este código, ignora este mensaje.',
    ].join('\n'),
    html: [
      '<div style="font-family:Arial,sans-serif;color:#0e1a2b;line-height:1.6">',
      '<p>Usa este código para verificar tu email en Sherlock:</p>',
      `<p style="font-family:monospace;font-size:28px;letter-spacing:0.18em"><strong>${code}</strong></p>`,
      '<p>El código vence en 10 minutos y solo se puede usar una vez.</p>',
      '<p>Verificar tu email no concede acceso a ningún documento ni sala.</p>',
      '<p>Si no solicitaste este código, ignora este mensaje.</p>',
      '</div>',
    ].join(''),
  }
}

/**
 * El idioma del OTP sale de la invitación persistida, nunca del request: el
 * correo se entrega fuera del contexto del navegador y el invitado ya recibió
 * su invitación en un idioma concreto. Sin dato (filas legacy) asume español.
 */
const resolveInvitationLocale = Effect.fn('GuestDelivery.resolveLocale')(function* (
  ctx: MutationCtx,
  invitationHandle: string
) {
  return yield* Effect.gen(function* () {
    const invitationHandleHash = yield* convexPromise(() => hashInvitationHandle(invitationHandle))
    const invitation = yield* convexPromise(() =>
      ctx.db
        .query('guestInvitations')
        .withIndex('by_invitationHandleHash', (q) =>
          q.eq('invitationHandleHash', invitationHandleHash)
        )
        .unique()
    )
    return invitation?.locale ?? 'es'
  }).pipe(Effect.catchCause(() => Effect.succeed('es' as GuestInvitationLocale)))
})

const lockUndeliveredChallenge = Effect.fn('GuestDelivery.lockUndeliveredChallenge')(function* (
  ctx: MutationCtx,
  challengeToken: string,
  now: number
) {
  yield* Effect.gen(function* () {
    const challengeTokenHash = yield* convexPromise(() => hashChallengeToken(challengeToken))
    const challenge = yield* convexPromise(() =>
      ctx.db
        .query('guestOtpChallenges')
        .withIndex('by_challengeTokenHash', (q) => q.eq('challengeTokenHash', challengeTokenHash))
        .unique()
    )
    if (challenge?.status === 'ISSUED') {
      yield* convexPromise(() => ctx.db.patch(challenge._id, { status: 'LOCKED', lockedAt: now }))
    }
    // La respuesta sigue siendo genérica y el caller no recibe el token real.
    // Si la transacción completa revierte, Convex elimina también el challenge.
  }).pipe(Effect.catchCause(() => Effect.void))
})

/**
 * Prepara el challenge y encola el OTP dentro de la misma mutation de Convex.
 * Solo retorna el token público; email y código viven únicamente en memoria
 * durante el enqueue y nunca se escriben en las tablas de Sherlock.
 */
const requestGuestOtpDeliveryEffect = Effect.fn('GuestDelivery.requestOtp')(function* (
  ctx: MutationCtx,
  input: { invitationHandle: string; email: string; now: number }
) {
  const now = input.now
  const config = getEmailConfiguration()
  if (!config) return genericChallengeResponse()

  const prepared = yield* convexPromise(() => prepareOtpChallengeForDelivery(ctx, input))
  const delivery = prepared.delivery
  if (!delivery) return prepared.response

  // El envío se traga cualquier fallo A PROPÓSITO —incluido un defecto— para
  // no filtrarle al navegador si el buzón existe. Lo que no se traga es la
  // consecuencia: el challenge que no salió queda LOCKED.
  return yield* Effect.gen(function* () {
    const locale = yield* resolveInvitationLocale(ctx, input.invitationHandle)
    const content = buildOtpEmail(delivery.code, locale)
    yield* convexPromise(() =>
      resend.sendEmail(ctx, {
        from: config.from,
        to: delivery.destination,
        ...content,
      })
    )
    return prepared.response
  }).pipe(
    Effect.catchCause(() =>
      Effect.gen(function* () {
        yield* lockUndeliveredChallenge(ctx, prepared.response.challengeToken, now)
        return genericChallengeResponse()
      })
    )
  )
})

export function requestGuestOtpDelivery(
  ctx: MutationCtx,
  input: { invitationHandle: string; email: string; now?: number }
): Promise<GenericOtpChallengeResponse> {
  return runConvex(requestGuestOtpDeliveryEffect(ctx, { ...input, now: input.now ?? Date.now() }))
}
