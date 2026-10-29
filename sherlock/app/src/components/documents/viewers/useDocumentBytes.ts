'use client'

import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Effect, Exit, Schema } from 'effect'
import type { Fiber } from 'effect'

import { runClientEffect, runClientFork } from '@/lib/effect/client-runtime'
import { describeCause } from '@/lib/effect/errors'

export type ViewerBytesState =
  { status: 'loading' } | { status: 'ready'; bytes: ArrayBuffer } | { status: 'error' }

/** Query sobre un grant ya emitido. El grant es de un solo uso: no se pide otro. */
export function withGrantQuery(url: string, query: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${query}`
}

// ============================================================================
// EL FALLO, CON NOMBRE
// ============================================================================
// No se exporta: el contrato del hook sigue siendo las tres etiquetas de
// `ViewerBytesState`, que es lo que los visores ya leen. El tag existe para que
// el canal de error del programa distinga las dos formas de no tener bytes: la
// entrega que el servidor rechaza (`refused`, con su status: un grant quemado
// da 403) y la que nunca llegó a la red (`transport`).

class DocumentBytesError extends Schema.TaggedError<DocumentBytesError>()('DocumentBytesError', {
  reason: Schema.Literals(['transport', 'refused']),
  status: Schema.optionalKey(Schema.Number),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function transportError(cause: unknown): DocumentBytesError {
  return new DocumentBytesError({
    reason: 'transport',
    message: describeCause(cause),
    cause,
  })
}

// One in-flight request per grant url. The grant is single-use on the server,
// so a second fetch of the same url (StrictMode replaying the effect, a parent
// remount) would burn it and land on 403 while the first one succeeds.
const inflight = new Map<string, Promise<ArrayBuffer>>()

/**
 * La entrega, como programa con nombre.
 *
 * `Effect.tryPromise` entrega un `AbortSignal` y aquí NO se usa a propósito: el
 * grant es de un solo uso y el servidor ya contabilizó la entrega cuando la
 * respuesta empezó a llegar. Abortar el fetch no devuelve el permiso, solo tira
 * bytes que ya se pagaron. Lo que se corta es la fibra que espera, no la
 * descarga.
 */
const deliverDocument = Effect.fn('DocumentBytes.deliver')(function* (
  url: string
): Effect.fn.Return<ArrayBuffer, DocumentBytesError> {
  const response = yield* Effect.tryPromise({
    try: () => fetch(url, { cache: 'no-store', credentials: 'same-origin' }),
    catch: transportError,
  })

  if (!response.ok) {
    return yield* Effect.fail(
      new DocumentBytesError({
        reason: 'refused',
        status: response.status,
        message: `HTTP ${response.status}`,
      })
    )
  }

  return yield* Effect.tryPromise({ try: () => response.arrayBuffer(), catch: transportError })
})

function fetchDocumentBytes(url: string): Promise<ArrayBuffer> {
  const pending = inflight.get(url)
  if (pending) return pending

  // Lo que se cachea es la PROMESA, no el programa: un Effect es una
  // descripción y volver a correrlo volvería a pedir el grant.
  const request = runClientEffect(deliverDocument(url)).finally(() => {
    inflight.delete(url)
  })

  inflight.set(url, request)
  return request
}

type BytesLoader = (url: string) => Promise<ArrayBuffer>
const DocumentBytesContext = createContext<BytesLoader | null>(null)

// Bytes por apertura: `activeUrl` (el grant) identifica la apertura; dentro de
// ella se cachea cada URL pedida, porque el visor PPTX pide
// `viewUrl&rendition=pdf` y un remount (cruzar el corte de escritorio) volvia
// a bajar esa URL y quemaba el grant de un solo uso (Grok, #551). Vive fuera
// de React: el compilador prohibe mutar locales del render desde un callback,
// y cerrar la apertura borra la entrada para no retener bytes auditados.
const openings = new Map<string, Map<string, Promise<ArrayBuffer>>>()

function fetchWithinOpening(activeUrl: string, url: string): Promise<ArrayBuffer> {
  let opened = openings.get(activeUrl)
  if (!opened) {
    opened = new Map()
    openings.set(activeUrl, opened)
  }
  let request = opened.get(url)
  if (!request) {
    request = fetchDocumentBytes(url)
    opened.set(url, request)
  }
  return request
}

/** Mantiene los bytes solo mientras esta apertura de la sala siga activa. */
export function DocumentBytesProvider({
  activeUrl,
  children,
}: {
  activeUrl: string | null
  children?: ReactNode
}) {
  useEffect(() => {
    if (!activeUrl) return
    return () => {
      openings.delete(activeUrl)
    }
  }, [activeUrl])
  const load = useMemo<BytesLoader>(
    () => (url) => (activeUrl ? fetchWithinOpening(activeUrl, url) : fetchDocumentBytes(url)),
    [activeUrl]
  )
  return createElement(DocumentBytesContext.Provider, { value: load }, children)
}

type SettledBytes = { url: string; value: ViewerBytesState }

/**
 * El resultado ya resuelto para una URL. El programa no falla: decide, y por
 * eso el borde solo tiene que mirar si la fibra terminó o si la interrumpieron.
 */
const settleDocument = Effect.fn('DocumentBytes.settle')(function* (
  url: string,
  load: BytesLoader
): Effect.fn.Return<SettledBytes> {
  return yield* Effect.tryPromise({ try: () => load(url), catch: transportError }).pipe(
    Effect.match({
      onSuccess: (bytes): SettledBytes => ({ url, value: { status: 'ready', bytes } }),
      onFailure: (): SettledBytes => ({ url, value: { status: 'error' } }),
    })
  )
})

/**
 * Descarga los bytes del documento con el grant ya emitido.
 *
 * `no-store` es obligatorio: el grant es de un solo uso y auditado, asi que el
 * archivo no puede quedar en la cache HTTP del navegador para reabrirse sin
 * pasar por la bitacora.
 *
 * Cambiar de documento interrumpe la FIBRA que espera, no la descarga: un Exit
 * interrumpido no pinta estado, y la entrega que el servidor ya contabilizó
 * termina de llegar a la cache de la apertura, donde un remount la reusa.
 */
export function useDocumentBytes(url: string | null): ViewerBytesState {
  const load = useContext(DocumentBytesContext) ?? fetchDocumentBytes
  const [settled, setSettled] = useState<SettledBytes | null>(null)

  useEffect(() => {
    if (!url) return

    const fiber: Fiber.Fiber<SettledBytes> = runClientFork(settleDocument(url, load))
    fiber.addObserver((exit) => {
      // Interrumpida por otra URL o por el unmount: no hay estado que pintar.
      if (Exit.isSuccess(exit)) setSettled(exit.value)
    })

    return () => {
      fiber.interruptUnsafe()
    }
  }, [url, load])

  if (!url) return { status: 'error' }
  return settled?.url === url ? settled.value : { status: 'loading' }
}
