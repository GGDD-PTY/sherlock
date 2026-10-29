// ============================================================================
// MOCK: @/lib/api/with-auth (variantes admin)
// ============================================================================
// ES: Fake ligero de `requireAdminApiAuth` para tests de rutas admin. Replica
//     el contrato real (401 de sesión → 403 de rol → 403 de step-up) sin tocar
//     WorkOS/Convex/cookies, y permite simular una cookie de step-up vencida.
// EN: Lightweight fake of `requireAdminApiAuth` for admin route tests.
// ============================================================================

import { NextResponse } from 'next/server'

const ADMIN_STEP_UP_REQUIRED_CODE = 'ADMIN_STEP_UP_REQUIRED'

const ADMIN_STEP_UP_REQUIRED_MESSAGE =
  'Se requiere re-autenticación de administrador (SSO o Passkey) reciente'

type AuthResultLike = { user: { role?: string } | null; error: unknown }

export function createWithAuthAdminMock(options: {
  requireApiAuth: () => AuthResultLike | Promise<AuthResultLike>
  hasRecentAdminStepUp?: () => boolean
}) {
  const requireApiAuth = async (): Promise<AuthResultLike> => await options.requireApiAuth()

  const hasRecentAdminApiStepUp = async (): Promise<boolean> =>
    options.hasRecentAdminStepUp ? options.hasRecentAdminStepUp() : true

  const requireAdminApiAuth = async (): Promise<AuthResultLike> => {
    const result = await requireApiAuth()

    if (result.error) {
      return result
    }

    if (result.user?.role !== 'ADMIN') {
      return {
        user: null,
        error: NextResponse.json({ error: 'No autorizado' }, { status: 403 }),
      }
    }

    if (!(await hasRecentAdminApiStepUp())) {
      return {
        user: null,
        error: NextResponse.json(
          { error: ADMIN_STEP_UP_REQUIRED_MESSAGE, code: ADMIN_STEP_UP_REQUIRED_CODE },
          { status: 403 }
        ),
      }
    }

    return result
  }

  return { requireApiAuth, requireAdminApiAuth, hasRecentAdminApiStepUp }
}
