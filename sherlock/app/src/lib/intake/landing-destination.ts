// La landing consulta esta ruta ANTES de guardar o subir un byte. Si la sesión
// ya tiene Data Room propio, el visitante ve el nombre y decide; si no, el
// camino anónimo sigue igual. Un fallo de red o del servidor conserva la
// selección y exige reintentar la consulta antes de continuar.

import { Effect } from 'effect'

import { runClientEffect } from '@/lib/effect/client-runtime'

export type LandingDestinationResult =
  { status: 'FOUND'; companyName: string } | { status: 'NONE' } | { status: 'UNAVAILABLE' }

export function readLandingDestination(signal?: AbortSignal): Promise<LandingDestinationResult> {
  return runClientEffect(
    Effect.tryPromise(async (): Promise<LandingDestinationResult> => {
      const timeout = AbortSignal.timeout(8_000)
      const response = await fetch('/api/intake/destination', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null) return { status: 'UNAVAILABLE' }
      if (response.status === 401 && 'error' in body && body.error === 'Unauthorized') {
        return { status: 'NONE' }
      }
      if (!response.ok || !('companyName' in body)) return { status: 'UNAVAILABLE' }
      const companyName = body.companyName
      if (companyName === null) return { status: 'NONE' }
      if (typeof companyName !== 'string') return { status: 'UNAVAILABLE' }
      const trimmed = companyName.trim()
      return trimmed.length > 0
        ? { status: 'FOUND', companyName: trimmed }
        : { status: 'UNAVAILABLE' }
    }).pipe(Effect.orElseSucceed(() => ({ status: 'UNAVAILABLE' }) as const))
  )
}
