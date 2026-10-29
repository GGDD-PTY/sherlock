// ============================================================================
// CAPACIDAD ADMIN SOBRE LA SALA DE UN CLIENTE
// ============================================================================
// ===== LA COSTURA CON EFFECT =====
// La emisión del bearer es una llamada a nuestra propia API y la respuesta
// entraba con un `as { capability?: unknown } | null` — un casteo ciego sobre
// un JSON que nadie había mirado. Ahora el payload se decodifica con
// `effect/Schema` (`capability` tiene que ser una cadena no vacía) y el fallo
// tiene nombre y span: `AdminVdr.issueCapability`.
//
// Lo que NO cambia, porque hay un test que lo fija: el bearer vive solo en este
// frame y en la mutation de Convex que sigue. No se cachea, no se loguea, no va
// a una URL ni a una cookie. El programa devuelve la cadena y el borde la mete
// en el objeto que se le entrega a Convex; el error que se lanza es el mismo
// `AdminVdrCapabilityError` de antes, con su código estable en `code` y nunca
// en `message`.

import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { Effect, Option, Schema } from 'effect'

import { runClientEffect } from '@/lib/effect/client-runtime'
import { logApiError, readApiError } from '@/lib/vdr/read-api-error'

import type { AdminVdrAction } from '@/../convex/_adminVdr/capabilityFormat'

const AdminVdrCapabilityContext = createContext<string | null>(null)

/** Código estable de fallo local; es lo que la UI mapea a copy bilingüe. */
const ADMIN_VDR_CAPABILITY_UNAVAILABLE = 'ADMIN_VDR_CAPABILITY_UNAVAILABLE'

/**
 * Falla cerrada de la emisión del bearer admin. El token de máquina vive en
 * `code` — nunca en `message`, porque un `message` termina renderizado en un
 * toast tarde o temprano y el usuario no puede hacer nada con un identificador
 * en SCREAMING_SNAKE_CASE.
 */
export class AdminVdrCapabilityError extends Schema.TaggedError<AdminVdrCapabilityError>()(
  'AdminVdrCapabilityError',
  {
    code: Schema.Literals([ADMIN_VDR_CAPABILITY_UNAVAILABLE]),
    message: Schema.String,
  }
) {}

// `apiSuccess` mete su `requestId` al lado del cuerpo, así que la decodificación
// ignora lo que sobra y solo exige lo único que esta llamada necesita.
const CapabilityPayload = Schema.Struct({ capability: Schema.NonEmptyString })
const decodeCapabilityPayload = Schema.decodeUnknownOption(CapabilityPayload)

type IssueRequest = {
  companyId: string
  action: AdminVdrAction
  target: string
  input: Record<string, unknown>
}

/**
 * Emite el bearer. Falla cerrada: una respuesta que no es 2xx, un cuerpo que no
 * es JSON o un `capability` que no es una cadena no vacía son el mismo error.
 * Un fallo de red sigue viajando como el rechazo original —`Effect.promise` lo
 * deja como defecto— para que el llamador lo distinga de una denegación.
 */
const issueCapability = Effect.fn('AdminVdr.issueCapability')(function* (
  request: IssueRequest
): Effect.fn.Return<string, AdminVdrCapabilityError> {
  const response = yield* Effect.promise(() =>
    fetch('/api/admin/vdr-capabilities', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  )
  if (!response.ok) {
    const apiError = yield* readApiError(response)
    yield* logApiError('Admin VDR capability issuance failed', apiError)
    return yield* new AdminVdrCapabilityError({
      code: ADMIN_VDR_CAPABILITY_UNAVAILABLE,
      message: 'Admin VDR capability issuance failed',
    })
  }

  const payload = yield* Effect.promise(() => response.json().catch(() => null))
  const decoded = decodeCapabilityPayload(payload)
  if (Option.isNone(decoded)) {
    return yield* new AdminVdrCapabilityError({
      code: ADMIN_VDR_CAPABILITY_UNAVAILABLE,
      message: 'Admin VDR capability issuance failed',
    })
  }

  return decoded.value.capability
})

export function AdminVdrCapabilityProvider({
  companyId,
  children,
}: {
  companyId: string | null
  children: ReactNode
}) {
  return (
    <AdminVdrCapabilityContext.Provider value={companyId}>
      {children}
    </AdminVdrCapabilityContext.Provider>
  )
}

/** True when this tree is operating another company's room as the Sherlock team. */
export function useAdminVdrOperator(): boolean {
  return useContext(AdminVdrCapabilityContext) !== null
}

export function useAdminVdrCapability() {
  const companyId = useContext(AdminVdrCapabilityContext)

  return useCallback(
    async <T extends Record<string, unknown>>(
      action: AdminVdrAction,
      target: string,
      input: T,
      companyIdOverride?: string | null
    ): Promise<T & { adminCapability?: string }> => {
      const targetCompanyId = companyIdOverride ?? companyId
      if (!targetCompanyId) return input

      const capability = await runClientEffect(
        issueCapability({ companyId: targetCompanyId, action, target, input })
      )

      // The bearer exists only in this call frame and the immediately following
      // Convex mutation. It is never cached, logged, placed in a URL, or stored.
      return { ...input, adminCapability: capability }
    },
    [companyId]
  )
}
