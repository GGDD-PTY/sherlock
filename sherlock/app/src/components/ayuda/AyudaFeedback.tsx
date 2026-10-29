'use client'

// ============================================================================
// LA ÚNICA CAJA DE TEXTO DEL HUB DE AYUDA
// ============================================================================
// El 2026-08-27 Maintainer reportó DOS cajas de texto en la pantalla de soporte y
// nadie sabía cuál llegaba a quién. Aquí hay exactamente una, y el destino lo
// decide la sesión, no el visitante:
//
//   - cliente COMPANY con sala → `support.sendCompanyMessage`, así el mensaje
//     aterriza en el mismo hilo que el equipo lee en /admin/support;
//   - cualquier otro → `roadmap.submitFeatureRequest`, la cola pública que un
//     humano cura antes de que llegue al tablero.
//
// El rol se resuelve del lado del servidor de Convex en ambas mutations. Este
// componente solo elige a cuál llamar. La elección exige un veredicto: mientras
// la sesión o la sala no hayan resuelto, el botón espera. Enviar antes mandaba
// el mensaje privado de un cliente a la cola pública diciéndole que había
// llegado al equipo. Solo un anónimo confirmado —o una sala resuelta en null—
// va a esa cola.
// ============================================================================

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { Effect, Schema } from 'effect'

import { api } from '@/../convex/_generated/api'
import { extractConvexErrorCode } from '@/components/shared/convex-error-code'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { getRoadmapDeviceToken } from '@/lib/roadmap/device-token'
import { runClientEffect } from '@/lib/effect/client-runtime'

const MESSAGE_MAX_LENGTH = 2_000

export type AyudaFeedbackLabels = {
  heading: string
  label: string
  placeholder: string
  submit: string
  sending: string
  resolving: string
  sentCompany: string
  sentAnonymous: string
  duplicate: string
  error: string
  rateLimited: string
  emailFallback: string
  emailSubject: string
}

type FeedbackState =
  'idle' | 'pending' | 'sentCompany' | 'sentAnonymous' | 'duplicate' | 'error' | 'rateLimited'

/** Lo que el envío puede terminar siendo. `idle` y `pending` son de la UI. */
type FeedbackOutcome = Exclude<FeedbackState, 'idle' | 'pending'>
/** Lo que el servidor puede confirmar; los otros dos los pone el fallo. */
type FeedbackDelivery = Exclude<FeedbackOutcome, 'error' | 'rateLimited'>

class FeedbackNotDelivered extends Schema.TaggedError<FeedbackNotDelivered>()(
  'FeedbackNotDelivered',
  { cause: Schema.Defect() }
) {}

// El programa no falla hacia la UI: decide cuál de los cinco desenlaces fue.
const sendFeedback = Effect.fn('Ayuda.sendFeedback')(function* (
  deliver: () => Promise<FeedbackDelivery>
): Effect.fn.Return<FeedbackOutcome> {
  return yield* Effect.tryPromise({
    try: deliver,
    catch: (cause) => new FeedbackNotDelivered({ cause }),
  }).pipe(
    Effect.catch((failure) => {
      const code = extractConvexErrorCode(failure.cause)
      return Effect.logError('[ayuda] feedback failed', code).pipe(
        Effect.as<FeedbackOutcome>(code === 'RATE_LIMIT_EXCEEDED' ? 'rateLimited' : 'error')
      )
    })
  )
})

export function AyudaFeedback({ labels }: { labels: AyudaFeedbackLabels }) {
  const [body, setBody] = useState('')
  const [state, setState] = useState<FeedbackState>('idle')
  const { hasRole, isLoading } = useCurrentUser()

  // `getMyVdrWorkspace` exige sesión: pedirla sin rol COMPANY convertiría un
  // hub público en un error de render.
  const isCompany = hasRole('COMPANY')
  const workspace = useQuery(api.companies.getMyVdrWorkspace, isCompany ? {} : 'skip')
  const companyId = workspace?.company?._id ?? null
  // `undefined` es "todavía no sé", no "no hay sala": una sala resuelta en null
  // sí es un veredicto y va a la cola pública. `isLoading` ya cubre la sesión
  // firmada cuyo rol todavía viaja, que es exactamente cuando `hasRole` miente.
  const isResolvingDestination = isLoading || (isCompany && workspace === undefined)

  const sendCompanyMessage = useMutation(api.support.sendCompanyMessage)
  const submitFeatureRequest = useMutation(api.roadmap.submitFeatureRequest)

  const messages: Partial<Record<FeedbackState, string>> = {
    sentCompany: labels.sentCompany,
    sentAnonymous: labels.sentAnonymous,
    duplicate: labels.duplicate,
    error: labels.error,
    rateLimited: labels.rateLimited,
  }
  const message = messages[state]

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const text = body.trim()
    if (text.length === 0 || state === 'pending' || isResolvingDestination) return

    setState('pending')

    const outcome = await runClientEffect(
      sendFeedback(async () => {
        if (companyId) {
          await sendCompanyMessage({ companyId, body: text })
          return 'sentCompany'
        }
        const result = await submitFeatureRequest({
          // El sitio ships solo en español y la mutation solo acepta `es`: el
          // idioma no viaja como prop porque no hay un segundo valor posible.
          body: text,
          locale: 'es',
          deviceToken: getRoadmapDeviceToken(),
        })
        return result.stored ? 'sentAnonymous' : 'duplicate'
      })
    )
    // Solo se limpia el texto cuando quedó almacenado: en un duplicado, en un
    // fallo o en un límite de tasa el visitante conserva lo que escribió.
    if (outcome === 'sentCompany' || outcome === 'sentAnonymous') setBody('')
    setState(outcome)
  }

  return (
    // Sin regla ni aire propio: la sección vive en la columna izquierda del
    // hub y la jerarquía la pone el h2, no una línea.
    <section
      aria-labelledby="ayuda-feedback-heading"
      className="bg-secondary grid content-start gap-4 rounded-md p-4"
    >
      <h2 id="ayuda-feedback-heading" className="font-sans text-base leading-tight font-semibold">
        {labels.heading}
      </h2>

      <form onSubmit={(...args) => void handleSubmit(...args)} className="grid gap-3">
        <label htmlFor="ayuda-feedback" className="sr-only">
          {labels.label}
        </label>
        <textarea
          id="ayuda-feedback"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          maxLength={MESSAGE_MAX_LENGTH}
          rows={3}
          placeholder={labels.placeholder}
          className="border-border bg-background focus-visible:border-primary w-full rounded-md border p-3 text-sm leading-relaxed outline-none"
        />
        <div className="flex flex-wrap items-center gap-4">
          {/* El único CTA relleno de la página: todo lo demás del hub es
              outline, ghost o texto. */}
          <button
            type="submit"
            disabled={state === 'pending' || isResolvingDestination}
            aria-busy={state === 'pending' || isResolvingDestination}
            className="bg-primary text-primary-foreground focus-visible:ring-ring/50 inline-flex h-10 items-center justify-center rounded-md px-4 text-sm font-medium outline-none focus-visible:ring-[3px] disabled:opacity-60"
          >
            {isResolvingDestination
              ? labels.resolving
              : state === 'pending'
                ? labels.sending
                : labels.submit}
          </button>
        </div>
      </form>

      <p role="status" aria-live="polite" className="text-muted-foreground text-sm leading-relaxed">
        {message ?? ''}
      </p>
    </section>
  )
}
