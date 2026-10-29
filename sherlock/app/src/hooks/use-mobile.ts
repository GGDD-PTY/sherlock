'use client'

import { useEffect, useState } from 'react'
import { Effect } from 'effect'

import { runClientSync } from '@/lib/effect/client-runtime'

// El corte `md` de Tailwind. Debajo de él la barra lateral deja de ser una
// columna y pasa a ser un Sheet, así que este número tiene que ser el mismo
// que usan las clases `md:` del primitivo: si se separan, hay un rango de
// anchos donde ni la columna ni el Sheet se pintan.
const MOBILE_BREAKPOINT = 768
const MOBILE_QUERY = `(max-width: ${(MOBILE_BREAKPOINT - 1).toString()}px)`

const readIsMobile = Effect.fn('useIsMobile.read')(function* (media: MediaQueryList) {
  return yield* Effect.sync(() => media.matches)
})

/**
 * Arranca en `false` a propósito: el servidor no tiene `matchMedia` y el
 * primer render del cliente tiene que coincidir con el HTML que llegó.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false)

  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY)
    const sync = () => {
      setIsMobile(runClientSync(readIsMobile(media)))
    }

    sync()
    media.addEventListener('change', sync)
    return () => media.removeEventListener('change', sync)
  }, [])

  return isMobile
}
