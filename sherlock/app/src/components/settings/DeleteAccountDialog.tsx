'use client'

// ============================================================================
// DELETE ACCOUNT DIALOG COMPONENT
// ============================================================================
// Dialogo de confirmacion para eliminar cuenta (soft-delete).
// Usa startTransition para llamar al server action de forma no-blocking.
// ============================================================================

import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Effect } from 'effect'
import { useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { deleteAccount } from '@/app/[locale]/(app)/settings/actions'
import { useAuth } from '@/hooks/useAuth'
import { runClientEffect } from '@/lib/effect/client-runtime'

// ===== LA COSTURA CON EFFECT =====
// Pausar la cuenta termina cerrando la sesión y saliendo a `/sign-in`. Si
// `signOut` se rechazaba —red caída, sesión ya vencida— la promesa moría sin
// que nadie la escuchara Y el redirect no corría: el cliente se quedaba en
// Ajustes, con la cuenta ya pausada y sin señal de nada. El fallo ahora se
// registra y la salida ocurre igual, que es lo único correcto: la cuenta ya
// está pausada del lado del servidor.
const closeSessionAfterPause = Effect.fn('Settings.closeSessionAfterPause')(function* (
  signOut: () => Promise<void>
): Effect.fn.Return<void> {
  yield* Effect.tryPromise({
    try: () => signOut(),
    catch: (cause) => new Error('sign out after account pause failed', { cause }),
  }).pipe(
    Effect.tapError((error) => Effect.logError(error.message, error.cause)),
    Effect.ignore
  )
})

export function DeleteAccountDialog() {
  const [isPending, startTransition] = useTransition()
  const t = useTranslations('settings')
  const router = useRouter()
  const { signOut } = useAuth()

  const handleDeleteAccount = () => {
    startTransition(async () => {
      const result = await deleteAccount()

      if (!result.success) {
        toast.error(result.message)
        return
      }
      toast.success(t('deleteSuccess'))
      await runClientEffect(closeSessionAfterPause(signOut))
      router.push('/sign-in')
    })
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        {/* Pausar es reversible: `outline`, no `destructive`. El botón rojo queda
            reservado para la supresión real, que vive en Privacidad. */}
        <Button variant="outline">{t('deleteConfirmButton')}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteConfirmTitle')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              {t('deleteConfirmDescription')}
              <ul className="mt-2 list-disc space-y-1 pl-4">
                <li>{t('deleteConfirmProfile')}</li>
                <li>{t('deleteConfirmDeals')}</li>
                <li>{t('deleteConfirmAnalyses')}</li>
                <li>{t('deleteConfirmMessages')}</li>
              </ul>
              {/* La acción es un soft-delete (`users.deactivateOwnAccount`): desactiva
                  el perfil, no borra datos. Decirlo explícitamente y apuntar al flujo
                  real de supresión es lo que exige la sección 6 de la política. */}
              <p className="mt-3">{t('deleteConfirmRetention')}</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{t('deleteCancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleDeleteAccount} disabled={isPending}>
            {isPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t('deleting')}
              </>
            ) : (
              t('deleteConfirmButton')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
