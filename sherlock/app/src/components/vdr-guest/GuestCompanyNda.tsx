'use client'

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslations } from 'next-intl'
import { Effect, Exit, Option, Schema } from 'effect'
import type { Fiber } from 'effect'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { runClientEffect, runClientFork } from '@/lib/effect/client-runtime'

// ===== LA COSTURA CON EFFECT =====
// El NDA es el único control que el invitado puede completar solo, así que lo
// que llega del servidor se decodifica contra un schema —antes zod, ahora
// `effect/Schema`— y la carga vive en un programa que se corre en el borde. La
// fibra reemplaza al `AbortController`: al desmontar se interrumpe, la petición
// se aborta de verdad y un Exit interrumpido no pinta estado, así que los dos
// `if (!controller.signal.aborted)` desaparecen.

const ndaSchema = Schema.Struct({
  title: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(200))),
  content: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(12_000))),
  contentHash: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/))),
  version: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(100))),
  locale: Schema.Literals(['es', 'en']),
})
// `apiSuccess` agrega `requestId` al mismo nivel, así que la envoltura ignora
// claves de más; el NDA de adentro no, como antes con `.strict()`.
//
// Van en dos pasos porque `onExcessProperty` es una opción del parseo entero y
// no de un `Struct` (`ParseOptions` en `effect/SchemaAST`): pedirla en la
// envoltura rechazaba el `requestId` real y el invitado nunca veía su NDA.
const pickNda = Schema.decodeUnknownOption(Schema.Struct({ nda: Schema.Unknown }))
const decodeNda = Schema.decodeUnknownOption(ndaSchema, { onExcessProperty: 'error' })
const isAccepted = Schema.is(Schema.Struct({ accepted: Schema.Literal(true) }))

type Nda = typeof ndaSchema.Type

class GuestNdaUnavailable extends Schema.TaggedError<GuestNdaUnavailable>()(
  'GuestNdaUnavailable',
  {}
) {}

class GuestNdaDenied extends Schema.TaggedError<GuestNdaDenied>()('GuestNdaDenied', {}) {}

/** El NDA publicado, o nada: la UI no distingue entre «no hay» y «no se pudo». */
const loadNda = Effect.fn('GuestNda.load')(
  function* (): Effect.fn.Return<Nda | null, GuestNdaUnavailable> {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch('/api/vdr/guest/nda', { credentials: 'same-origin', cache: 'no-store', signal }),
      catch: () => new GuestNdaUnavailable(),
    })
    if (!response.ok) return null
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new GuestNdaUnavailable(),
    })
    const envelope = Option.getOrNull(pickNda(body))
    return envelope ? Option.getOrNull(decodeNda(envelope.nda)) : null
  },
  Effect.orElseSucceed(() => null)
)

const acceptNda = Effect.fn('GuestNda.accept')(
  function* (
    contentHash: string,
    signatoryName: string
  ): Effect.fn.Return<boolean, GuestNdaDenied> {
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch('/api/vdr/guest/nda', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentHash, signatoryName }),
          signal,
        }),
      catch: () => new GuestNdaDenied(),
    })
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: () => new GuestNdaDenied(),
    })
    return response.ok && isAccepted(body)
  },
  Effect.orElseSucceed(() => false)
)
export function GuestCompanyNda({ onAccepted }: { onAccepted: () => void }) {
  const t = useTranslations('vdrGuest')
  const [nda, setNda] = useState<Nda | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [name, setName] = useState('')
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const ndaFiberRef = useRef<Fiber.Fiber<Nda | null> | null>(null)
  const regionRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef<HTMLParagraphElement>(null)
  const mayMoveFocusRef = useRef(false)

  useEffect(() => {
    if (state !== 'ready' || !mayMoveFocusRef.current) return
    regionRef.current?.focus()
  }, [state])

  useEffect(() => {
    const fiber = runClientFork(loadNda())
    ndaFiberRef.current = fiber
    fiber.addObserver((exit) => {
      // Interrumpida por el desmontaje: no hay estado que pintar.
      if (!Exit.isSuccess(exit)) return
      const active = document.activeElement
      const loading = loadingRef.current
      mayMoveFocusRef.current =
        active === document.body ||
        active === null ||
        (loading !== null && (active === loading || loading.contains(active)))
      setNda(exit.value)
      setState(exit.value ? 'ready' : 'unavailable')
    })
    return () => {
      ndaFiberRef.current?.interruptUnsafe()
      ndaFiberRef.current = null
    }
  }, [])
  const accept = useCallback(
    async (event: FormEvent) => {
      event.preventDefault()
      if (!nda || !checked || name.trim().length < 2 || busy) return
      setBusy(true)
      setError(false)
      const accepted = await runClientEffect(acceptNda(nda.contentHash, name.trim()))
      setBusy(false)
      if (accepted) onAccepted()
      else setError(true)
    },
    [nda, checked, name, busy, onAccepted]
  )
  if (state === 'loading')
    return (
      <p role="status" ref={loadingRef}>
        {t('nda.loading')}
      </p>
    )
  if (state === 'unavailable' || !nda) return <p role="status">{t('nda.unavailable')}</p>
  return (
    <form onSubmit={(...args) => void accept(...args)} className="space-y-4">
      <section lang={nda.locale} aria-labelledby="guest-nda-title">
        <h2 id="guest-nda-title" className="font-sans text-lg leading-tight font-semibold">
          {nda.title}
        </h2>
        <p className="text-muted-foreground mb-3 text-sm">
          {t('nda.version', { version: nda.version })}
        </p>
        <div
          ref={regionRef}
          className="border-border max-h-96 overflow-y-auto rounded-md border p-4 text-sm leading-6 break-words whitespace-pre-wrap"
          tabIndex={0}
          role="region"
          aria-label={nda.title}
        >
          {nda.content}
        </div>
      </section>
      <div className="space-y-2">
        <Label htmlFor="guest-nda-signatory">{t('nda.signatory')}</Label>
        <Input
          id="guest-nda-signatory"
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          minLength={2}
          maxLength={150}
          autoComplete="name"
          disabled={busy}
        />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
          required
          disabled={busy}
          className="accent-primary h-4 w-4"
        />
        {t('nda.acceptCheck')}
      </label>
      {error && (
        <p role="alert" className="text-sm">
          {t('nda.error')}
        </p>
      )}
      <Button
        type="submit"
        disabled={busy || !checked || name.trim().length < 2}
        className="min-h-11"
      >
        {busy ? t('nda.accepting') : t('nda.accept')}
      </Button>
    </form>
  )
}
