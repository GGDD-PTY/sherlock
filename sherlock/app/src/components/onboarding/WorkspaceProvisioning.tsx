'use client'

import { withHandoffNonce } from '@/lib/mycroft/handoff-navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Effect, Exit, Schema } from 'effect'
import type { Fiber } from 'effect'
import { useMutation } from 'convex/react'
import { api } from '@/../convex/_generated/api'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useOnboardingAnalytics } from '@/hooks/useOnboardingAnalytics'
import { useRouter } from '@/i18n/navigation'
import { runClientFork } from '@/lib/effect/client-runtime'
import { loggers } from '@/lib/logger'

type ProvisioningStatus = 'pending' | 'error' | 'provisioned'

// ===== LA COSTURA CON EFFECT =====
// El aprovisionamiento es una llamada que decide a dónde va el cliente. Estaba
// encadenada con `.then/.catch` y su fallo era un `catch` anónimo; ahora el
// fallo tiene nombre y el resultado es un desenlace que el borde traduce a
// estado o a navegación.
//
// Además corre en una fibra: reintentar interrumpe el intento anterior y
// desmontar interrumpe el que esté en vuelo, así que una respuesta tardía ya no
// pinta estado ni navega por su cuenta.
class ProvisioningFailed extends Schema.TaggedError<ProvisioningFailed>()('ProvisioningFailed', {
  cause: Schema.Defect(),
}) {}

type ProvisioningOutcome<A> = { readonly ok: true; readonly result: A } | { readonly ok: false }

const requestWorkspace = Effect.fn('Onboarding.ensureWorkspace')(function* <A>(
  ensure: () => Promise<A>
): Effect.fn.Return<ProvisioningOutcome<A>> {
  return yield* Effect.tryPromise({
    try: ensure,
    catch: (cause) => new ProvisioningFailed({ cause }),
  }).pipe(
    Effect.map((result): ProvisioningOutcome<A> => ({ ok: true, result })),
    Effect.orElseSucceed((): ProvisioningOutcome<A> => ({ ok: false }))
  )
})

/**
 * `useOnboardingAnalytics` abre la sesión del embudo al MONTARSE y emite
 * `onboarding_abandoned` al desmontarse sin completar. Montarlo en la parada de
 * aprovisionamiento le inventaría un abandono a cada ADMIN y a cada degradación
 * al wizard —que además sigue el embudo—, así que el hook solo vive en el único
 * camino que de verdad lo completa.
 */
function ProvisionedWorkspaceHandoff({
  label,
  handoffNonce,
}: {
  label: string
  handoffNonce?: string | null
}) {
  const router = useRouter()
  const { trackStarted, trackCompleted } = useOnboardingAnalytics('COMPANY')

  useEffect(() => {
    trackStarted()
    trackCompleted(1, 1)
    // El destino es el workspace de documentos, y directo: el flujo mycroft
    // guarda los archivos del visitante en IndexedDB y es
    // MyCompanyDocumentsClient quien reclama ese stash al montar — un salto
    // intermedio los dejaría varados hasta expirar su TTL.
    router.replace(withHandoffNonce('/my-company/documents', handoffNonce))
  }, [router, trackStarted, trackCompleted, handoffNonce])

  return (
    <p role="status" className="text-muted-foreground text-sm">
      {label}
    </p>
  )
}

export function WorkspaceProvisioning({ handoffNonce }: { handoffNonce?: string | null } = {}) {
  const t = useTranslations('onboarding.provisioning')
  const router = useRouter()
  const ensureCompanyWorkspace = useMutation(api.companies.ensureCompanyWorkspace)
  const [status, setStatus] = useState<ProvisioningStatus>('pending')
  const hasRequestedProvisioning = useRef(false)

  const provisionFiberRef = useRef<Fiber.Fiber<
    ProvisioningOutcome<Awaited<ReturnType<typeof ensureCompanyWorkspace>>>
  > | null>(null)

  const provision = useCallback(() => {
    provisionFiberRef.current?.interruptUnsafe()
    const fiber = runClientFork(requestWorkspace(() => ensureCompanyWorkspace({})))
    provisionFiberRef.current = fiber
    fiber.addObserver((exit) => {
      if (provisionFiberRef.current !== fiber) return
      provisionFiberRef.current = null
      // Interrumpida por un reintento o por el desmontaje: no hay nada que hacer.
      if (!Exit.isSuccess(exit)) return
      const outcome = exit.value
      if (!outcome.ok) {
        // Solo el mensaje: el detalle del fallo y la identidad se quedan en el
        // servidor.
        loggers.onboarding.error('Workspace provisioning failed')
        setStatus('error')
        return
      }
      const result = outcome.result
      if (result.role === 'ADMIN') {
        router.replace('/admin')
        return
      }
      // Un COMPANY sin empresa significa que el aprovisionamiento fue negado
      // (binding enforced, membresías ambiguas). El wizard usa el mismo
      // resolver y tampoco puede guardar, así que mandarlo ahí es un
      // formulario que nunca funciona: el estado de error es el único honesto.
      if (result.role === 'COMPANY' && result.company === null) {
        loggers.onboarding.error('Workspace provisioning denied')
        setStatus('error')
        return
      }
      if (result.role === 'COMPANY') {
        // Identity accretes inside the preparation room. An incomplete legacy
        // profile is a readiness item, never a wizard gate.
        setStatus('provisioned')
        return
      }
      // Rol fuera de COMPANY/ADMIN: el root del
      // onboarding decide por estado y lo manda al home ([F] 2026-09-07 09:00).
      router.replace('/onboarding')
    })
  }, [ensureCompanyWorkspace, router])

  useEffect(() => {
    // Los rerenders conservan el intento. StrictMode limpia e interrumpe la
    // primera fibra; el replay debe reabrir la mutación idempotente.
    if (!hasRequestedProvisioning.current) {
      hasRequestedProvisioning.current = true
      provision()
    }
  }, [provision])

  // La interrupción va en su propio efecto, atado al montaje y no a `provision`.
  // Colgada del efecto de arriba, un re-render que cambiara la identidad de la
  // mutación disparaba su limpieza y mataba el reintento en vuelo: la pantalla
  // se quedaba en «Preparando tu espacio…» para siempre.
  useEffect(
    () => () => {
      provisionFiberRef.current?.interruptUnsafe()
      provisionFiberRef.current = null
      hasRequestedProvisioning.current = false
    },
    []
  )

  // El reintento salta el ref a propósito: lo pide el usuario, no el montaje.
  const handleRetry = () => {
    setStatus('pending')
    provision()
  }

  return (
    <div data-provisioning="true" className="flex min-h-[80vh] items-center justify-center p-4">
      {status === 'error' ? (
        <div className="w-full max-w-md space-y-4">
          <Alert>
            <AlertTitle>{t('error.title')}</AlertTitle>
            <AlertDescription>{t('error.description')}</AlertDescription>
          </Alert>
          <Button onClick={handleRetry}>{t('error.retry')}</Button>
        </div>
      ) : status === 'provisioned' ? (
        <ProvisionedWorkspaceHandoff label={t('status')} handoffNonce={handoffNonce} />
      ) : (
        <p role="status" className="text-muted-foreground text-sm">
          {t('status')}
        </p>
      )}
    </div>
  )
}
