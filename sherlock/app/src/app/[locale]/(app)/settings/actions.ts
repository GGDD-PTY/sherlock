'use server'

// ============================================================================
// SETTINGS SERVER ACTIONS
// ============================================================================
// Acciones de servidor para la pagina de configuracion
// Incluye: eliminacion de cuenta (soft delete)
//
// Una server action es un borde de confianza igual que una ruta de API: lo que
// entra viene del navegador. Por eso el programa vive en Effect, cada fallo
// tiene nombre (`AccountPauseError`) y el mensaje que ve el cliente sale de ese
// nombre, no de un `catch` que se traga cualquier cosa.
//
// Lo que NO entra al programa de Effect: `requireAuth()` y `signOut()`. Los dos
// terminan en el `redirect()` de Next, que viaja como un throw con `digest`
// `NEXT_REDIRECT`. Si ese throw cruza `Effect.runPromise`, sale envuelto en un
// `FiberFailure` que ya no tiene `digest` — verificado contra
// `effect@4.0.0-rc.112` y `next/dist/client/components/redirect-error.js`, que
// reconoce el redirect SOLO por esa propiedad. Envolverlos convertiría cada
// redirección en un 500. Se quedan afuera, en el borde, igual que en
// `lib/auth/session.ts`.
// ============================================================================

import { Effect, Schema } from 'effect'
import { revalidatePath } from 'next/cache'
import { unstable_rethrow } from 'next/navigation'
import { signOut } from '@workos-inc/authkit-nextjs'
import { requireAuth } from '@/lib/auth/session'
import { api } from '@/../convex/_generated/api'
import { Id } from '@/../convex/_generated/dataModel'
import { getAuthenticatedConvex } from '@/lib/convex-auth'
import { DEV_AUTH_ENABLED } from '@/lib/dev-auth/config'
import { defaultLocale } from '@/i18n/config'

// ===== TIPOS =====
export type ActionResult = {
  success: boolean
  message: string
}

// ===== FALLOS CON NOMBRE =====
// Cada rama que hoy devolvía un string suelto es una razón. El mensaje de cara
// al usuario se deriva de la razón (español panameño, tuteo), así que agregar
// una razón sin su copy deja de compilar.
const AccountPauseReasonSchema = Schema.Literals([
  'no-profile',
  'convex-unavailable',
  'mutation-failed',
])

type AccountPauseReason = typeof AccountPauseReasonSchema.Type

class AccountPauseError extends Schema.TaggedError<AccountPauseError>()('AccountPauseError', {
  reason: AccountPauseReasonSchema,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const ACCOUNT_PAUSE_MESSAGES: Record<AccountPauseReason, string> = {
  'no-profile': 'No autenticado',
  'convex-unavailable': 'No se pudo autenticar con Convex',
  'mutation-failed': 'Error al pausar la cuenta. Intenta de nuevo.',
}

// El perfil llega como `string | null` desde la sesión y hasta ahora se casteaba
// a `Id<'profiles'>` sin mirarlo: un perfil vacío entraba a la mutation igual.
// Aquí se prueba antes de castear.
const ProfileIdSchema = Schema.NonEmptyString

// ===== ELIMINAR CUENTA =====
// Soft-delete: desactiva el perfil en Convex (isActive = false)
// No elimina datos permanentemente - permite recuperacion por un admin si es necesario
const pauseAccountProgram = Effect.fn('Settings.pauseAccount')(function* (
  profileId: string | null | undefined
) {
  const decoded = Schema.decodeUnknownOption(ProfileIdSchema)(profileId)
  if (decoded._tag === 'None') {
    return yield* new AccountPauseError({ reason: 'no-profile' })
  }

  // Use authenticated Convex client so requireAuth() succeeds server-side
  const convexAuth = yield* Effect.tryPromise({
    try: () => getAuthenticatedConvex(),
    catch: (cause) => new AccountPauseError({ reason: 'convex-unavailable', cause }),
  })
  if (!convexAuth) {
    return yield* new AccountPauseError({ reason: 'convex-unavailable' })
  }

  yield* Effect.tryPromise({
    try: () =>
      convexAuth.client.mutation(api.users.deactivateOwnAccount, {
        profileId: decoded.value as Id<'profiles'>,
      }),
    catch: (cause) => new AccountPauseError({ reason: 'mutation-failed', cause }),
  })

  yield* Effect.sync(() => revalidatePath('/settings'))
})

export async function deleteAccount(): Promise<ActionResult> {
  // Fuera del programa: `requireAuth()` redirige, y su redirección no puede
  // cruzar el runtime de Effect (ver la cabecera del módulo).
  const user = await requireAuth()

  const outcome = await Effect.runPromise(
    pauseAccountProgram(user?.profileId).pipe(
      Effect.match({
        onSuccess: () => ({ ok: true as const }),
        onFailure: (error: AccountPauseError) => ({ ok: false as const, reason: error.reason }),
      })
    )
  ).catch((cause: unknown) => {
    // Un defecto —algo que ni siquiera llegó a ser un `AccountPauseError`—
    // sigue siendo un fallo que el cliente tiene que ver, no una pantalla en
    // blanco. `unstable_rethrow` es la puerta que deja pasar el control de
    // flujo de Next si alguna vez alguien mete uno adentro del programa.
    //
    // El log dice `pauseAccount` y no `deleteAccount` a propósito: la acción
    // pausa (soft-delete), no borra, y un log que dijera lo contrario mandaría
    // a buscar el fallo al lugar equivocado. Lo fija
    // `architecture/pr151-review-regressions.test.ts`.
    unstable_rethrow(cause)
    console.error('[pauseAccount] Error:', cause)
    return { ok: false as const, reason: 'mutation-failed' as const }
  })

  if (!outcome.ok) {
    return { success: false, message: ACCOUNT_PAUSE_MESSAGES[outcome.reason] }
  }

  // ===== REVOCACIÓN DE SESIÓN SERVER-SIDE =====
  // Sin esto, una sesión viva en otro dispositivo sigue apuntando a una cuenta
  // isActive:false ("app rota" en ese device). signOut() lanza el redirect de
  // Next (NEXT_REDIRECT), por eso vive FUERA del programa de Effect: envuelto
  // perdería el `digest` y la redirección se volvería un 500. El signOut
  // client-side del dialog queda como fallback (y es el camino en dev-auth).
  if (!DEV_AUTH_ENABLED) {
    await signOut({ returnTo: `/${defaultLocale}` })
  }

  return { success: true, message: 'Cuenta pausada exitosamente' }
}
