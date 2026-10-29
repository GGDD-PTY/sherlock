'use client'

import { FormEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Effect, Exit, Option, Schema } from 'effect'
import type { Fiber } from 'effect'
import { CircleDashed, KeyRound, LockKeyhole, LogOut, ShieldCheck } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { runClientEffect, runClientFork } from '@/lib/effect/client-runtime'
import { GuestCompanyNda } from './GuestCompanyNda'
import { GuestAuthorizedRoom } from './GuestAuthorizedRoom'
import { parseGuestAuthorizedRoom, type GuestRoom } from './guestRoomContract'

type Locale = 'es'

// ===== LA COSTURA CON EFFECT =====
// Éste es el camino del invitado: alguien sin cuenta que llega con un enlace,
// pide un código y, si la empresa ya lo autorizó, ve la sala. Todo lo que el
// componente sabe del mundo entra por cinco respuestas HTTP, así que cada una
// se decodifica contra un schema en vez de mirarle campos a un
// `Record<string, unknown>` casteado a ojo.
//
// Las llamadas viven en programas Effect y se corren en el borde con
// `runClientFork`. La fibra reemplaza al `AbortController`: interrumpirla corta
// la petición de verdad —`Effect.tryPromise` le pasa su propio `AbortSignal` al
// `fetch`— y un Exit interrumpido no pinta estado, que es lo que antes hacían a
// mano las comparaciones contra `'AbortError'`.

const GateSchema = Schema.Literals([
  'REAL_INTEREST',
  'MUTUAL_OPT_IN',
  'HUMAN_MATCH_APPROVAL',
  'RISK_DISCLOSURE',
  'NDA',
  'ROOM_GRANT',
])
type Gate = typeof GateSchema.Type

type JourneyState =
  | 'checking-session'
  | 'checking-room'
  | 'email'
  | 'code'
  | 'verified'
  | 'room'
  | 'invalid-link'
  | 'access-ended'
  | 'unavailable'
  | 'logged-out'

const HANDLE_PATTERN = /^[a-zA-Z0-9_-]{32,256}$/

// Igual que el enfriamiento del servidor (60 s). Un reenvío dentro de ese
// minuto recibiría un token que no se guardó y el código del correo dejaría
// de servir. El botón se queda apagado hasta que ese minuto pase.
const OTP_RESEND_COOLDOWN_MS = 60_000

// Un título por pantalla. El h1 se pinta una sola vez en el render y cada
// estado solo aporta sus claves de copy, así ninguna rama puede abrir un
// segundo título ni dejar la pantalla sin ninguno.
const SCREEN_COPY: Record<
  JourneyState,
  { readonly eyebrow: string; readonly title: string; readonly description: string | null }
> = {
  'checking-session': { eyebrow: 'journey.eyebrow', title: 'journey.title', description: null },
  'checking-room': { eyebrow: 'journey.eyebrow', title: 'journey.title', description: null },
  email: {
    eyebrow: 'journey.eyebrow',
    title: 'journey.emailTitle',
    description: 'journey.emailDescription',
  },
  code: {
    eyebrow: 'journey.eyebrow',
    title: 'journey.codeTitle',
    description: 'journey.codeDescription',
  },
  verified: {
    eyebrow: 'journey.verifiedEyebrow',
    title: 'journey.verifiedTitle',
    description: 'journey.verifiedDescription',
  },
  // El título de la sala lo trae el servidor; esta clave es el respaldo si la
  // proyección todavía no llegó.
  room: { eyebrow: 'room.eyebrow', title: 'journey.title', description: 'room.description' },
  'invalid-link': {
    eyebrow: 'journey.eyebrow',
    title: 'journey.invalidTitle',
    description: 'journey.invalidDescription',
  },
  'access-ended': {
    eyebrow: 'journey.eyebrow',
    title: 'journey.accessEndedTitle',
    description: 'journey.accessEndedDescription',
  },
  unavailable: {
    eyebrow: 'journey.eyebrow',
    title: 'journey.unavailableTitle',
    description: 'journey.unavailableDescription',
  },
  'logged-out': {
    eyebrow: 'journey.eyebrow',
    title: 'journey.loggedOutTitle',
    description: 'journey.loggedOutDescription',
  },
}

declare global {
  interface Window {
    __SHERLOCK_VDR_GUEST_HANDLE__?: string
  }
}

// La lista completa de controles es la misma lista del schema. Antes eran dos
// definiciones —la unión de tipos y este arreglo— que coincidían por cuidado de
// quien las editara; ahora agregar un control en un solo lugar las mueve a las
// dos.
const DEFAULT_GATES: readonly Gate[] = GateSchema.literals

// Una lista de controles solo sirve si son todos conocidos y ninguno se repite.
// Cualquier otra cosa vuelve a la lista completa: mostrar de menos sería decirle
// al invitado que le falta menos de lo que le falta.
const GateListSchema = Schema.Array(GateSchema).pipe(
  Schema.check(
    Schema.makeFilter((gates) => new Set(gates).size === gates.length, { title: 'gatesAreUnique' })
  )
)
const decodeGates = Schema.decodeUnknownOption(GateListSchema)

function validGates(value: unknown): readonly Gate[] {
  return Option.getOrElse(decodeGates(value), () => DEFAULT_GATES)
}

// ===== LAS RESPUESTAS =====
// Cada guardia es la forma mínima que hace avanzar el flujo. Claves de más se
// ignoran, como antes; lo que cambia es que la forma está declarada en un solo
// lugar en vez de repartida en comparaciones sueltas sobre un objeto casteado.
const isRevokedSession = Schema.is(Schema.Struct({ authenticated: Schema.Literal(false) }))
const isLiveSession = Schema.is(Schema.Struct({ authenticated: Schema.Literal(true) }))
const isGatedSession = Schema.is(
  Schema.Struct({
    authenticated: Schema.Literal(true),
    roomAccessGranted: Schema.Literal(false),
    requiredGates: Schema.optionalKey(Schema.Unknown),
  })
)
const isCodeAccepted = Schema.is(
  Schema.Struct({
    accepted: Schema.Literal(true),
    challengeToken: Schema.String.pipe(Schema.check(Schema.isPattern(HANDLE_PATTERN))),
  })
)
const isEmailVerified = Schema.is(
  Schema.Struct({ verified: Schema.Literal(true), roomAccessGranted: Schema.Literal(false) })
)
const isLoggedOut = Schema.is(Schema.Struct({ loggedOut: Schema.Literal(true) }))

// Lo único que puede fallar acá es llegar al servidor. El error tiene nombre
// para que el canal `E` no sea `unknown`; la UI lo trata como su fallo genérico.
class GuestTransportError extends Schema.TaggedError<GuestTransportError>()('GuestTransportError', {
  path: Schema.String,
}) {}

type GuestResponse = { readonly status: number; readonly ok: boolean; readonly body: unknown }

const guestRequest = Effect.fn('VdrGuest.request')(function* (
  path: string,
  init: RequestInit
): Effect.fn.Return<GuestResponse, GuestTransportError> {
  const response = yield* Effect.tryPromise({
    // El `signal` es el de la fibra: interrumpirla aborta el fetch de verdad.
    try: (signal) =>
      fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init, signal }),
    catch: () => new GuestTransportError({ path }),
  })
  // Un cuerpo que no es JSON no necesita rama propia: `{}` no pasa ninguna
  // guardia, así que cae en el mismo camino genérico de siempre.
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => new GuestTransportError({ path }),
  }).pipe(Effect.orElseSucceed((): unknown => ({})))
  return { status: response.status, ok: response.ok, body }
})

// ===== LOS DESENLACES =====
// Los programas no fallan hacia la UI: deciden. El componente traduce cada
// desenlace a estado y no vuelve a razonar sobre respuestas.
type RoomOutcome =
  | { readonly _tag: 'Authorized'; readonly room: GuestRoom }
  | { readonly _tag: 'GatesPending'; readonly gates: readonly Gate[] }
  | { readonly _tag: 'AccessEnded' }
  | { readonly _tag: 'Unavailable' }

type SessionOutcome = RoomOutcome | { readonly _tag: 'NeedsInvitation' }

const projectGuestRoom = Effect.fn('VdrGuest.projectRoom')(function* (): Effect.fn.Return<
  RoomOutcome,
  GuestTransportError
> {
  const { status, ok, body } = yield* guestRequest('/api/vdr/guest/room', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  if (status === 401 && isRevokedSession(body)) return { _tag: 'AccessEnded' }
  if (!ok || !isLiveSession(body)) return { _tag: 'Unavailable' }
  if (isGatedSession(body)) return { _tag: 'GatesPending', gates: validGates(body.requiredGates) }
  const room = parseGuestAuthorizedRoom(body)
  return room ? { _tag: 'Authorized', room } : { _tag: 'Unavailable' }
})

/** La carga de la sala, avisando primero que empezó para que la UI ponga su spinner. */
const loadGuestRoom = Effect.fn('VdrGuest.loadRoom')(
  function* (onStart: () => void): Effect.fn.Return<RoomOutcome, GuestTransportError> {
    yield* Effect.sync(onStart)
    return yield* projectGuestRoom()
  },
  Effect.orElseSucceed((): RoomOutcome => ({ _tag: 'Unavailable' }))
)

const checkGuestSession = Effect.fn('VdrGuest.checkSession')(
  function* (
    onStart: () => void,
    onRoomStart: () => void
  ): Effect.fn.Return<SessionOutcome, GuestTransportError> {
    yield* Effect.sync(onStart)
    const { ok, body } = yield* guestRequest('/api/vdr/guest/session', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
    if (ok && isGatedSession(body)) return yield* loadGuestRoom(onRoomStart)
    if (!ok) return { _tag: 'Unavailable' }
    return { _tag: 'NeedsInvitation' }
  },
  Effect.orElseSucceed((): SessionOutcome => ({ _tag: 'Unavailable' }))
)

type CodeOutcome =
  { readonly _tag: 'Sent'; readonly challengeToken: string } | { readonly _tag: 'Failed' }

const requestGuestCode = Effect.fn('VdrGuest.requestCode')(
  function* (
    invitationHandle: string,
    email: string
  ): Effect.fn.Return<CodeOutcome, GuestTransportError> {
    const { status, body } = yield* guestRequest('/api/vdr/guest/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ invitationHandle, email }),
    })
    if (status !== 202 || !isCodeAccepted(body)) return { _tag: 'Failed' }
    return { _tag: 'Sent', challengeToken: body.challengeToken }
  },
  Effect.orElseSucceed((): CodeOutcome => ({ _tag: 'Failed' }))
)

const verifyGuestCode = Effect.fn('VdrGuest.verifyCode')(
  function* (
    invitationHandle: string,
    challengeToken: string,
    code: string
  ): Effect.fn.Return<boolean, GuestTransportError> {
    const { ok, body } = yield* guestRequest('/api/vdr/guest/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ invitationHandle, challengeToken, code }),
    })
    return ok && isEmailVerified(body)
  },
  Effect.orElseSucceed(() => false)
)

const logoutGuest = Effect.fn('VdrGuest.logout')(
  function* (): Effect.fn.Return<boolean, GuestTransportError> {
    const { ok, body } = yield* guestRequest('/api/vdr/guest/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: '{}',
    })
    return ok && isLoggedOut(body)
  },
  Effect.orElseSucceed(() => false)
)

export function GuestInvitationJourney({ locale }: { locale: Locale }) {
  const t = useTranslations('vdrGuest')
  const capturedOnce = useRef(false)
  const invitationHandle = useRef<string | null>(null)
  const [captureReady, setCaptureReady] = useState(false)
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0)
  const [state, setState] = useState<JourneyState>('checking-session')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [challengeToken, setChallengeToken] = useState<string | null>(null)
  const [resendLockedUntil, setResendLockedUntil] = useState<number | null>(null)
  const [resendClock, setResendClock] = useState(0)
  const [gates, setGates] = useState<readonly Gate[]>(DEFAULT_GATES)
  const [room, setRoom] = useState<GuestRoom | null>(null)
  const [busy, setBusy] = useState<'request' | 'verify' | 'logout' | null>(null)
  const [formError, setFormError] = useState(false)

  // La fibra en vuelo de la sala. Reemplaza al `AbortController`: una carga
  // nueva o el desmontaje interrumpen la anterior, y su Exit interrumpido no
  // pinta nada.
  const roomFiberRef = useRef<Fiber.Fiber<SessionOutcome> | null>(null)

  useEffect(() => {
    if (resendLockedUntil === null) return
    const id = window.setInterval(() => {
      const now = Date.now()
      if (now >= resendLockedUntil) {
        setResendLockedUntil(null)
        return
      }
      setResendClock(now)
    }, 1_000)
    return () => window.clearInterval(id)
  }, [resendLockedUntil])

  const resendWaitSeconds =
    resendLockedUntil === null
      ? 0
      : Math.max(0, Math.ceil((resendLockedUntil - resendClock) / 1_000))

  const startCheckingRoom = useCallback(() => {
    setRoom(null)
    setState('checking-room')
  }, [])

  const applyOutcome = useCallback((outcome: SessionOutcome) => {
    switch (outcome._tag) {
      case 'Authorized':
        setGates([])
        setRoom(outcome.room)
        setState('room')
        return
      case 'GatesPending':
        setGates(outcome.gates)
        setState('verified')
        return
      case 'AccessEnded':
        setGates(DEFAULT_GATES)
        setState('access-ended')
        return
      case 'NeedsInvitation':
        setState(invitationHandle.current ? 'email' : 'invalid-link')
        return
      case 'Unavailable':
        setRoom(null)
        setState('unavailable')
    }
  }, [])

  /** Corre un programa de sala en el borde y deja que su desenlace pinte el estado. */
  const runRoomProgram = useCallback(
    (program: Effect.Effect<SessionOutcome>) => {
      roomFiberRef.current?.interruptUnsafe()
      const fiber = runClientFork(program)
      roomFiberRef.current = fiber
      fiber.addObserver((exit) => {
        if (roomFiberRef.current === fiber) roomFiberRef.current = null
        if (Exit.isSuccess(exit)) applyOutcome(exit.value)
      })
    },
    [applyOutcome]
  )

  const loadRoom = useCallback(() => {
    runRoomProgram(loadGuestRoom(startCheckingRoom))
  }, [runRoomProgram, startCheckingRoom])

  useLayoutEffect(() => {
    if (capturedOnce.current) return
    capturedOnce.current = true

    // La página server captura el fragmento durante el parseo, antes de la
    // hidratación global. Este fallback mantiene el componente seguro y
    // testeable si se monta fuera de esa página.
    const bootstrappedHandle = window.__SHERLOCK_VDR_GUEST_HANDLE__
    delete window.__SHERLOCK_VDR_GUEST_HANDLE__
    const rawFragment =
      typeof bootstrappedHandle === 'string'
        ? bootstrappedHandle
        : window.location.hash.startsWith('#')
          ? window.location.hash.slice(1)
          : ''
    // Next 16.3.3 parchea `window.history.replaceState` y despacha
    // ACTION_RESTORE. El prototipo queda nativo: limpiar por ahí no
    // despacha. La guarda se queda; el script inline de la página ya
    // limpió la barra en la ruta real.
    if (window.location.hash !== '' || window.location.search !== '') {
      History.prototype.replaceState.call(
        window.history,
        window.history.state,
        '',
        window.location.pathname
      )
    }

    let decoded = ''
    try {
      decoded = decodeURIComponent(rawFragment)
    } catch {
      decoded = ''
    }
    invitationHandle.current = HANDLE_PATTERN.test(decoded) ? decoded : null
    // Este efecto sí sincroniza con un sistema externo: borra el global que
    // dejó el parseo y, si aún hay fragmento o query, limpia la barra. La
    // bandera es el resultado de ese trabajo, no un valor derivable en render,
    // y leerlo en render rompería la hidratación porque el fragmento no existe
    // en el servidor.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCaptureReady(true)
  }, [])

  useEffect(() => {
    if (!captureReady) return
    runRoomProgram(
      checkGuestSession(
        () => setState('checking-session'),
        () => {
          // Con sesión viva el handle ya cumplió: lo que sigue lo autoriza la
          // cookie, no el enlace.
          invitationHandle.current = null
          startCheckingRoom()
        }
      )
    )
    return () => {
      roomFiberRef.current?.interruptUnsafe()
      roomFiberRef.current = null
    }
  }, [captureReady, runRoomProgram, startCheckingRoom, sessionCheckAttempt])

  async function requestCode(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault()
    const handle = invitationHandle.current
    if (!handle || !email.trim() || busy) return
    if (resendLockedUntil !== null && Date.now() < resendLockedUntil) return
    setBusy('request')
    setFormError(false)
    const outcome = await runClientEffect(requestGuestCode(handle, email.trim()))
    setBusy(null)
    if (outcome._tag === 'Failed') {
      setFormError(true)
      return
    }
    const sentAt = Date.now()
    setResendClock(sentAt)
    setResendLockedUntil(sentAt + OTP_RESEND_COOLDOWN_MS)
    setChallengeToken(outcome.challengeToken)
    setCode('')
    setState('code')
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const handle = invitationHandle.current
    if (!handle || !challengeToken || !/^\d{6}$/.test(code) || busy) return
    setBusy('verify')
    setFormError(false)
    const verified = await runClientEffect(verifyGuestCode(handle, challengeToken, code))
    setBusy(null)
    if (!verified) {
      setFormError(true)
      return
    }
    invitationHandle.current = null
    setEmail('')
    setCode('')
    setChallengeToken(null)
    setGates(DEFAULT_GATES)
    loadRoom()
  }

  async function logout() {
    if (busy) return
    setBusy('logout')
    setFormError(false)
    const loggedOut = await runClientEffect(logoutGuest())
    setBusy(null)
    if (!loggedOut) {
      setFormError(true)
      return
    }
    setRoom(null)
    setGates(DEFAULT_GATES)
    setState('logged-out')
  }

  const screen = SCREEN_COPY[state]
  // La sala autorizada presta su nombre al único título de la pantalla.
  const heading = state === 'room' && room ? room.title : t(screen.title)
  const wide = state === 'room'

  return (
    <div data-sensitive className="bg-background flex min-h-[calc(100dvh-7.5rem)] flex-col">
      <section
        className={
          wide
            ? 'mx-auto my-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8'
            : 'mx-auto my-auto w-full max-w-md px-4 py-8 sm:px-6'
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-muted-foreground text-xs font-semibold tracking-[0.18em] uppercase">
            {t(screen.eyebrow)}
          </p>
          <Badge variant="outline" className="gap-1.5">
            <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
            {t('journey.protected')}
          </Badge>
        </div>
        {/* El camino cambia de estado sin navegar: la sesión vence, el acceso
            termina o la lectura falla mientras el invitado mira la pantalla.
            El título y su descripción viven en una región viva para que ese
            cambio se anuncie; `unavailable` es el único que interrumpe. */}
        <div role={state === 'unavailable' ? 'alert' : 'status'} aria-atomic="true">
          <h1 className="mt-4">{heading}</h1>
          {screen.description ? (
            <p className="text-muted-foreground mt-2 text-base leading-7">
              {t(screen.description)}
            </p>
          ) : null}
        </div>

        {state === 'checking-session' || state === 'checking-room' ? (
          <div className="mt-6 flex items-center gap-3" role="status" aria-live="polite">
            <CircleDashed
              className="text-primary h-5 w-5 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            <p className="text-muted-foreground text-sm">
              {state === 'checking-room' ? t('journey.checkingRoom') : t('journey.checking')}
            </p>
          </div>
        ) : null}

        {state === 'email' ? (
          <form onSubmit={(...args) => void requestCode(...args)} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="vdr-guest-email">{t('journey.email')}</Label>
              <Input
                id="vdr-guest-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={t('journey.emailPlaceholder')}
                className="min-h-11"
                disabled={busy !== null}
                required
                autoFocus
              />
            </div>
            {formError ? (
              <p role="alert" className="text-destructive text-sm">
                {t('journey.genericError')}
              </p>
            ) : null}
            <Button
              type="submit"
              className="min-h-11 w-full"
              disabled={!email.trim() || busy !== null}
            >
              <KeyRound className="mr-2 h-4 w-4" aria-hidden />
              {busy === 'request' ? t('journey.requesting') : t('journey.requestCode')}
            </Button>
          </form>
        ) : null}

        {state === 'code' ? (
          <form onSubmit={(...args) => void verifyCode(...args)} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="vdr-guest-code">{t('journey.code')}</Label>
              <Input
                id="vdr-guest-code"
                type="text"
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder={t('journey.codePlaceholder')}
                className="font-data min-h-11 text-lg tracking-[0.28em]"
                disabled={busy !== null}
                required
                autoFocus
              />
            </div>
            {formError ? (
              <p role="alert" className="text-destructive text-sm">
                {t('journey.genericError')}
              </p>
            ) : null}
            <div className="space-y-2">
              <Button
                type="submit"
                className="min-h-11 w-full"
                disabled={code.length !== 6 || busy !== null}
              >
                <ShieldCheck className="mr-2 h-4 w-4" aria-hidden />
                {busy === 'verify' ? t('journey.verifying') : t('journey.verify')}
              </Button>
              {resendWaitSeconds > 0 ? (
                <p id="vdr-guest-resend-wait" className="text-muted-foreground text-sm">
                  {t('journey.resendWait', { seconds: resendWaitSeconds })}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                className="min-h-11 w-full"
                disabled={busy !== null || resendWaitSeconds > 0}
                aria-describedby={resendWaitSeconds > 0 ? 'vdr-guest-resend-wait' : undefined}
                onClick={() => void requestCode()}
              >
                {busy === 'request' ? t('journey.requesting') : t('journey.resend')}
              </Button>
            </div>
          </form>
        ) : null}

        {state === 'verified' ? (
          <div className="mt-6 space-y-5">
            {/* Cuando el NDA es el único control pendiente, el formulario es el
                control: repetirlo abajo como fila de una lista sería el mismo
                bloque dos veces en una pantalla. */}
            {gates.length === 1 && gates[0] === 'NDA' ? (
              <GuestCompanyNda onAccepted={loadRoom} />
            ) : (
              <>
                <p className="text-sm leading-6 font-semibold">{t('journey.noDocuments')}</p>
                <div>
                  <h2 className="font-sans text-sm leading-tight font-semibold">
                    {t('journey.gateTitle')}
                  </h2>
                  <ul className="divide-border mt-1 divide-y" aria-label={t('journey.gateTitle')}>
                    {gates.map((gate) => (
                      <li key={gate} className="flex items-center gap-3 py-2 text-sm">
                        <CircleDashed
                          className="text-muted-foreground h-4 w-4 shrink-0"
                          aria-hidden
                        />
                        <span>{t(`journey.gates.${gate}`)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground mt-2 text-sm leading-6">
                    {t('journey.gateDescription')}
                  </p>
                </div>
              </>
            )}
            {formError ? (
              <p role="alert" className="text-destructive text-sm">
                {t('journey.genericError')}
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className="min-h-11 w-full"
              disabled={busy !== null}
              onClick={() => void logout()}
            >
              <LogOut className="mr-2 h-4 w-4" aria-hidden />
              {busy === 'logout' ? t('journey.loggingOut') : t('journey.logout')}
            </Button>
          </div>
        ) : null}

        {state === 'room' && room ? (
          <GuestAuthorizedRoom
            room={room}
            locale={locale}
            busy={busy !== null}
            formError={formError}
            onLogout={() => void logout()}
          />
        ) : null}

        {state === 'unavailable' ? (
          <Button
            type="button"
            variant="outline"
            className="mt-6 min-h-11 w-full"
            onClick={() => {
              setState('checking-session')
              setSessionCheckAttempt((current) => current + 1)
            }}
          >
            {t('journey.retry')}
          </Button>
        ) : null}

        {state === 'email' || state === 'code' || state === 'invalid-link' ? (
          <p className="text-muted-foreground mt-6 text-xs leading-5">{t('invitationIds')}</p>
        ) : null}
      </section>
    </div>
  )
}
