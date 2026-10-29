'use client'

import { Activity, FileText, LockKeyhole } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useMutation } from 'convex/react'
import { Effect, Exit, Option, Schema } from 'effect'
import type { Fiber } from 'effect'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { Link, usePathname, useRouter } from '@/i18n/navigation'
import { useDirectVdrUpload } from '@/hooks/useDirectVdrUpload'
import { warmDirectVdrUpload } from '@/lib/documents/direct-upload'
import { runClientEffectExit, runClientFork } from '@/lib/effect/client-runtime'
import {
  HANDOFF_QUERY_PARAM,
  companyBornFromHandoff,
  handoffBelongsToVisit,
  readHandoffNonce,
  stripHandoffNonce,
} from '@/lib/mycroft/handoff-claim'
import { ackHandoffCompanyName, ackHandoffFiles, peekHandoff } from '@/lib/mycroft/upload-handoff'
import { trackRoomJourney } from '@/lib/analytics/room-journey'
import { trackSellSideEventOnce } from '@/lib/analytics/sell-side'
import { INTAKE_CLAIM_RETRY_COOKIE, INTAKE_CLAIM_RETRY_MARKER } from '@/lib/intake/claim-analytics'
import { INTAKE_CSRF_HEADER } from '@/lib/intake/config'
import { Button } from '@/components/ui/button'
import {
  CompanyRoomHeader,
  PAGE_IDENTITY_CLASS,
  ROOM_SCREEN_CONTAINER_CLASS,
} from '@/components/company/CompanyRoomHeader'
import { ROOM_SCREENS, type RoomScreen } from '@/components/company/roomScreens'
import { Skeleton } from '@/components/ui/skeleton'
import { RoomShell, type RoomShellNavigationHandle } from '@/components/documents/shell/RoomShell'
import { VdrDeleteDialog, VdrEditDialog } from './vdr/VdrDocumentDialogs'
import { VdrDocumentVersionsDialog } from './vdr/VdrDocumentVersionsDialog'
import { getVdrShellFolderLabel } from '@/lib/vdr/document-taxonomy'
import { normalizeVdrLocale } from './vdr/helpers'
import { VdrUploadDialog } from './vdr/VdrUploadDialog'
import { VdrWorkspaceErrorBoundary, VdrWorkspaceFailure } from './vdr/VdrWorkspaceErrorBoundary'
import { VDR_ACCESS_LEVELS, VDR_COPY } from './vdr/config'
import { readOpenSourceRequest, type OpenSourceRequest } from './vdr/workspace-url-state'
import type { VdrDocumentView, VdrLocale } from './vdr/types'
import { useCompanyVdr } from './vdr/useCompanyVdr'
import { AdminVdrCapabilityProvider } from './vdr/AdminVdrCapabilityContext'

type Props = {
  companyId: string
  companyName: string
  /**
   * `_creationTime` de la empresa. Decide solo si el NOMBRE del sobre de la
   * landing bautiza la sala: un alta nueva (nacida en torno al parqueo, con
   * tolerancia de reloj) se renombra; una sala que ya existía conserva el suyo.
   * Los archivos no dependen de esta fecha: los reclama la llave de la URL.
   */
  companyCreatedAt?: number | null
  companyLogoUrl?: string | null
  /** Mandato declarado por el cliente; `UNSET` deja la portada en neutro. */
  companyMandate?: 'DEBT' | 'EQUITY' | 'BOTH' | 'BRIDGE' | 'UNSET' | null
  isDemo?: boolean
  accessMode?: 'MANAGE' | 'READ_ONLY'
  /** La bitácora de accesos es superficie de admin ([F] 2026-09-01): quien la
   *  puede ver pasa la ruta, y su ausencia apaga el botón. Un solo dato manda,
   *  así que la sala del cliente no la ofrece. */
  activityHref?: string
  adminOperator?: boolean
  /** Pantallas que la barra ofrece; la página las resuelve con `roomScreensFor`. */
  screens?: readonly RoomScreen[]
  /** Lista de la sala corporativa resuelta en el servidor; `null` si no se pudo. */
  initialDocuments?: VdrDocumentView[] | null
}

const pageIdentityCopy = {
  es: { title: 'Data Room', loading: 'Cargando tu Data Room seguro' },
}

const demoRoomEvidenceCopy = {
  es: 'Documentos de ejemplo. Sube los tuyos para empezar.',
} as const

const memberCopy = {
  es: {
    eyebrow: 'Acceso de solo lectura',
    description:
      'Tu rol de miembro de la empresa te permite revisar el índice documental autorizado. Publicaciones, cargas, permisos, diligencia, analítica y exportaciones de auditoría siguen restringidas al dueño de la empresa.',
    index: 'Índice documental autorizado',
    indexDescription:
      'Esta vista expone únicamente metadata documental. No concede descargas ni permisos de administración.',
    empty: 'No hay documentos indexados en este alcance por ahora.',
    folder: 'Carpeta',
    access: 'Acceso',
  },
} as const

// En escritorio (lg) navbar 4rem + pie 3.5rem: la sala llena lo que queda y el
// árbol scrollea adentro. Debajo de lg la página scrollea (O5-04-4).
const DOCUMENTS_SCREEN_HEIGHT_CLASS = 'lg:h-[calc(100dvh-7.5rem)]'

export function MyCompanyDocumentsClient({
  companyId,
  companyName,
  companyCreatedAt = null,
  companyLogoUrl = null,
  companyMandate = null,
  isDemo = false,
  accessMode = 'MANAGE',
  activityHref,
  adminOperator = false,
  screens = ROOM_SCREENS,
  initialDocuments = null,
}: Props) {
  const locale = normalizeVdrLocale(useLocale())
  const router = useRouter()
  const searchParams = useSearchParams()
  // La llave del sobre se lee una sola vez, en el primer render: `useCompanyVdr`
  // normaliza la URL de la sala en su primer efecto y tira cualquier parámetro
  // que no sea suyo, así que después de ese render ya no está. Vive aquí y no
  // en el workspace para sobrevivir al remount del botón de reintento.
  const [handoffNonce] = useState(() => readHandoffNonce(searchParams.get(HANDOFF_QUERY_PARAM)))
  // La fuente citada desde otra pantalla también se lee una sola vez, por la
  // misma razón: la normalización de la URL la tira en el primer efecto.
  const [openSourceRequest] = useState(() => readOpenSourceRequest(searchParams))
  const [workspaceAttempt, setWorkspaceAttempt] = useState(0)

  const retryWorkspace = () => {
    router.refresh()
    setWorkspaceAttempt((current) => current + 1)
  }

  return (
    <AdminVdrCapabilityProvider companyId={adminOperator ? companyId : null}>
      <VdrWorkspaceErrorBoundary locale={locale} onRetry={retryWorkspace}>
        <CompanyVdrWorkspace
          key={workspaceAttempt}
          companyId={companyId}
          companyName={companyName}
          companyCreatedAt={companyCreatedAt}
          companyLogoUrl={companyLogoUrl}
          companyMandate={companyMandate}
          handoffNonce={handoffNonce}
          openSourceRequest={openSourceRequest}
          isDemo={isDemo}
          accessMode={accessMode}
          activityHref={activityHref}
          locale={locale}
          onRetry={retryWorkspace}
          adminOperator={adminOperator}
          screens={screens}
          initialDocuments={initialDocuments}
        />
      </VdrWorkspaceErrorBoundary>
    </AdminVdrCapabilityProvider>
  )
}

type WorkspaceProps = Required<
  Pick<
    Props,
    | 'companyId'
    | 'companyName'
    | 'companyLogoUrl'
    | 'companyMandate'
    | 'isDemo'
    | 'accessMode'
    | 'adminOperator'
    | 'screens'
    | 'initialDocuments'
  >
> &
  Pick<Props, 'activityHref' | 'companyCreatedAt'> & {
    /** Llave del sobre leída de `?handoff=` al entrar; `null` si la visita no trae ninguna. */
    handoffNonce: string | null
    /** Fuente citada desde la pantalla de preparación; se abre al montar el shell. */
    openSourceRequest: OpenSourceRequest | null
    locale: VdrLocale
    onRetry: () => void
  }

// El nivel de acceso viaja como enum del schema (`NDA_REQUIRED`). El miembro
// lee la etiqueta del catálogo, nunca el literal en mayúsculas.
const DEFAULT_ACCESS_LEVEL = 'NDA_REQUIRED'

function accessLevelLabel(value: string | null | undefined, locale: VdrLocale): string {
  const level =
    VDR_ACCESS_LEVELS.find((entry) => entry.value === value) ??
    VDR_ACCESS_LEVELS.find((entry) => entry.value === DEFAULT_ACCESS_LEVEL)
  return level?.label[locale] ?? DEFAULT_ACCESS_LEVEL
}

function memberIndexFolderLabel(
  folder: string | null | undefined,
  locale: VdrLocale,
  unassigned: string
): string {
  if (typeof folder !== 'string' || folder.trim().length === 0) return unassigned
  return getVdrShellFolderLabel(folder, locale)
}

function CompanyMemberDocumentIndex({
  documents,
  locale,
}: {
  documents: VdrDocumentView[]
  locale: VdrLocale
}) {
  const copy = memberCopy[locale]
  const t = useTranslations('vdr')

  return (
    <div data-testid="member-document-index" className="min-h-0 flex-1 space-y-5 overflow-y-auto">
      <section
        className="border-border bg-card rounded-md border p-5"
        aria-labelledby="member-vdr-access"
      >
        <div className="flex items-start gap-3">
          <LockKeyhole className="text-primary mt-0.5 h-5 w-5 shrink-0" aria-hidden />
          <div>
            <h3 id="member-vdr-access" className="text-sm font-semibold">
              {copy.eyebrow}
            </h3>
            <p className="text-muted-foreground mt-1 max-w-3xl text-sm leading-6">
              {copy.description}
            </p>
          </div>
        </div>
      </section>

      <section
        className="border-border bg-card rounded-md border"
        aria-labelledby="member-vdr-index"
      >
        <div className="border-border border-b px-5 py-4">
          <h3 id="member-vdr-index" className="text-base font-semibold">
            {copy.index}
          </h3>
          <p className="text-muted-foreground mt-1 text-sm leading-6">{copy.indexDescription}</p>
        </div>

        {documents.length === 0 ? (
          <p className="text-muted-foreground px-5 py-8 text-sm">{copy.empty}</p>
        ) : (
          <ul className="divide-border divide-y">
            {documents.map((document) => (
              <li key={document._id} className="flex items-start gap-3 px-5 py-4">
                <FileText className="text-primary mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold [overflow-wrap:anywhere]">{document.name}</p>
                  <dl className="text-muted-foreground mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs">
                    <div className="flex gap-1.5">
                      <dt>{copy.folder}:</dt>
                      <dd>
                        {memberIndexFolderLabel(document.folder, locale, t('folders.unassigned'))}
                      </dd>
                    </div>
                    <div className="flex gap-1.5">
                      <dt>{copy.access}:</dt>
                      <dd>{accessLevelLabel(document.accessLevel, locale)}</dd>
                    </div>
                  </dl>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

/**
 * El intake de la landing aterriza solo: se lee una vez, se encola, se sube sin
 * diálogo y al asentar la sala decide si todavía tiene que pedir un reintento.
 * Una sola progresión en un ref, no banderas sueltas que deban coincidir.
 * `READING` y `SETTLING` son los dos momentos en vuelo: mientras el peek o la
 * subida no resuelven, ningún render puede volver a disparar el paso.
 */
type HandoffArrival = 'IDLE' | 'READING' | 'QUEUED' | 'UPLOADING' | 'SETTLING' | 'SETTLED'

// ============================================================================
// LA COSTURA CON EFFECT
// ============================================================================
// Dos fronteras de este archivo entraban sin mirar.
//
// El reintento del reclamo del intake lee dos respuestas de nuestra propia API
// y las casteaba a `Record<string, unknown>` para después revisar los campos a
// mano, uno por uno. Ahora cada respuesta se decodifica con `effect/Schema`
// contra la forma exacta que el flujo necesita, y las dos peticiones viajan con
// el `AbortSignal` que `Effect.tryPromise` le da al programa: salir de la sala
// a mitad del reintento las cancela de verdad, en vez de dejarlas terminar para
// nadie.
//
// El sobre parqueado por la landing se leía con un `void peekHandoff().then(…)`
// sin dueño. Si el cliente se iba mientras IndexedDB respondía, el `.then`
// corría igual: encolaba archivos, renombraba la empresa y tocaba la URL de una
// sala desmontada. Ahora es una fibra que la limpieza del montaje interrumpe.
//
// Las dos fibras se guardan en refs y se interrumpen en un efecto SIN
// dependencias, no en la limpieza del efecto que las lanza: ese efecto depende
// de `vdr`, que es un objeto nuevo en cada render, y su limpieza mataría la
// carga en el render siguiente.

const IntakeSessionPayload = Schema.Struct({
  authorized: Schema.Literal(true),
  csrfToken: Schema.NonEmptyString,
})

const IntakeClaimPayload = Schema.Struct({
  status: Schema.Literals(['SUCCEEDED']),
  claimedDocumentCount: Schema.Number.pipe(Schema.check(Schema.isFinite())),
})

const decodeIntakeSession = Schema.decodeUnknownOption(IntakeSessionPayload)
const decodeIntakeClaim = Schema.decodeUnknownOption(IntakeClaimPayload)

/** Falla cerrada: cualquier tropiezo deja la sesión temporal y su marcador vivos. */
class IntakeClaimNotRetried extends Schema.TaggedError<IntakeClaimNotRetried>()(
  'IntakeClaimNotRetried',
  {}
) {}

const readJson = (response: Response) => response.json().catch(() => null)

/**
 * Reclama otra vez los documentos del intake temporal. Devuelve solo cuando el
 * reclamo asentó: es la única condición que autoriza a borrar el marcador y
 * recargar la sala.
 */
const retryIntakeClaim = Effect.fn('CompanyDocuments.retryIntake')(function* (
  csrfHeader: string
): Effect.fn.Return<void, IntakeClaimNotRetried> {
  yield* Effect.sync(() => {
    document.cookie = `${INTAKE_CLAIM_RETRY_COOKIE}=${INTAKE_CLAIM_RETRY_MARKER}; Max-Age=300; Path=/; SameSite=Lax${window.location.protocol === 'https:' ? '; Secure' : ''}`
  })

  const sessionResponse = yield* Effect.tryPromise({
    try: (signal) =>
      fetch('/api/intake/session', {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      }),
    catch: () => new IntakeClaimNotRetried(),
  })
  const session = decodeIntakeSession(yield* Effect.promise(() => readJson(sessionResponse)))
  if (!sessionResponse.ok || Option.isNone(session)) {
    return yield* new IntakeClaimNotRetried()
  }

  const claimResponse = yield* Effect.tryPromise({
    try: (signal) =>
      fetch('/api/intake/claim', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', [csrfHeader]: session.value.csrfToken },
        body: '{}',
        signal,
      }),
    catch: () => new IntakeClaimNotRetried(),
  })
  const claim = decodeIntakeClaim(yield* Effect.promise(() => readJson(claimResponse)))
  if (!claimResponse.ok || Option.isNone(claim)) {
    return yield* new IntakeClaimNotRetried()
  }
})

/** El sobre que la landing pudo haber parqueado, leído con dueño. */
const readParkedHandoff = Effect.fn('CompanyDocuments.peekHandoff')(function* () {
  return yield* Effect.promise(() => peekHandoff())
})

class CompanyRenameFailed extends Schema.TaggedError<CompanyRenameFailed>()('CompanyRenameFailed', {
  cause: Schema.Defect(),
}) {}

const renameCompanyRoom = Effect.fn('CompanyDocuments.rename')(function* (
  updateCompany: (args: { companyId: Id<'companies'>; name: string }) => Promise<unknown>,
  args: { companyId: Id<'companies'>; name: string }
): Effect.fn.Return<void, CompanyRenameFailed> {
  yield* Effect.tryPromise({
    try: () => updateCompany(args),
    catch: (cause) => new CompanyRenameFailed({ cause }),
  }).pipe(
    Effect.tapError((error) => Effect.logError('Error al renombrar la empresa:', error.cause))
  )
})

function CompanyVdrWorkspace({
  companyId,
  companyName,
  companyCreatedAt,
  companyLogoUrl,
  companyMandate,
  handoffNonce,
  openSourceRequest,
  isDemo,
  accessMode,
  activityHref,
  locale,
  onRetry,
  adminOperator,
  screens,
  initialDocuments,
}: WorkspaceProps) {
  const [loadingTimedOut, setLoadingTimedOut] = useState(false)
  const copy = VDR_COPY[locale]
  const router = useRouter()
  const pathname = usePathname()
  const updateCompany = useMutation(api.companies.updateCompany)
  const [renamedCompanyName, setRenamedCompanyName] = useState<string | null>(null)
  const displayedCompanyName = renamedCompanyName ?? companyName

  const renameCompany = useCallback(
    async (nextName: string): Promise<boolean> => {
      const name = nextName.trim()
      if (!name) return false

      const exit = await runClientEffectExit(
        renameCompanyRoom(updateCompany, { companyId: companyId as Id<'companies'>, name })
      )
      if (!Exit.isSuccess(exit)) {
        return false
      }

      setRenamedCompanyName(name)
      router.refresh()
      return true
    },
    [companyId, router, updateCompany]
  )
  const uploadDocument = useDirectVdrUpload()
  const isReadOnly = accessMode === 'READ_ONLY'
  const handoffArrivalRef = useRef<HandoffArrival>('IDLE')
  const roomEnteredTrackedRef = useRef(false)
  const roomNavigationRef = useRef<RoomShellNavigationHandle | null>(null)
  // El sobre es de la visita que lo parqueó: la que llega con su llave en la
  // URL. La sala de ejemplo solo existe bajo dev-auth y no es el alta de nadie:
  // ahí no hay empresa real que renombrar ni cliente ajeno al que subirle
  // archivos, así que el aterrizaje local se sigue pudiendo ver completo.
  const ownsParkedHandoff = useCallback(
    (envelopeNonce: string | null) => {
      if (isDemo) return true
      return handoffBelongsToVisit({ urlNonce: handoffNonce, envelopeNonce })
    },
    [handoffNonce, isDemo]
  )
  // La llave sale de la URL cuando ya cumplió — el reclamo asentó o se decidió
  // descartarlo — y no antes: mientras esté pendiente, un reload es la segunda
  // oportunidad del sobre y sin llave no la tiene (`useCompanyVdr` la conserva
  // en su normalización justo por eso). Después sí estorba: un enlace copiado o
  // el historial la volverían a presentar. Se lee la URL viva y no el snapshot
  // del render, que puede ir un paso atrás de la normalización.
  const clearHandoffNonce = useCallback(() => {
    if (typeof window === 'undefined') return
    const search = window.location.search
    if (!new URLSearchParams(search).has(HANDOFF_QUERY_PARAM)) return
    const query = stripHandoffNonce(search)
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }, [pathname, router])
  // Un solo lugar cierra el aterrizaje: el estado terminal y la limpieza de la
  // URL viajan juntos para que ninguna rama suelte la llave a medio reclamo.
  const settleHandoffArrival = useCallback(() => {
    handoffArrivalRef.current = 'SETTLED'
    clearHandoffNonce()
  }, [clearHandoffNonce])
  // El veredicto de la cola solo se puede leer en un render, y la subida puede
  // asentar después del último que ella misma provocó (el ack de IndexedDB cruza
  // turnos del event loop). El asentado programa el suyo en vez de confiar en el
  // orden de los ticks.
  const [arrivalSettleTick, markArrivalSettled] = useReducer((tick: number) => tick + 1, 0)
  const claimRetryAttemptedRef = useRef(false)
  // Las dos cargas en vuelo de esta pantalla. Se interrumpen al desmontar; no
  // en la limpieza del efecto que las lanza, que corre en cada render.
  const claimRetryFiberRef = useRef<Fiber.Fiber<void, IntakeClaimNotRetried> | null>(null)
  const handoffPeekFiberRef = useRef<Fiber.Fiber<Awaited<ReturnType<typeof peekHandoff>>> | null>(
    null
  )
  const handoffFileIdsRef = useRef(new Map<File, number>())
  const acknowledgeHandoffFiles = async (files: readonly File[]) => {
    const ids = files.flatMap((file) => {
      const id = handoffFileIdsRef.current.get(file)
      return id === undefined ? [] : [id]
    })
    if (ids.length === 0 || !(await ackHandoffFiles(ids))) return
    for (const file of files) handoffFileIdsRef.current.delete(file)
  }
  const vdr = useCompanyVdr({
    companyId,
    isDemo,
    accessMode,
    locale,
    copy,
    initialDocuments,
    uploadDocument,
    onBatchUploadSuccess: acknowledgeHandoffFiles,
  })
  const findDocument = (documentId: string) =>
    vdr.documents.find((document) => document._id === documentId) ?? null
  // La fuente citada desde la pantalla de preparación se abre una sola vez,
  // cuando el shell ya montó y la lista llegó.
  const openSourceHandledRef = useRef(false)
  useEffect(() => {
    if (!openSourceRequest || openSourceHandledRef.current || vdr.isLoading) return
    const shell = roomNavigationRef.current
    if (!shell) return
    openSourceHandledRef.current = true
    shell.openSource({
      documentId: openSourceRequest.documentId as Id<'documents'>,
      ...(openSourceRequest.versionId
        ? { versionId: openSourceRequest.versionId as Id<'documentVersions'> }
        : {}),
      ...(openSourceRequest.navigate ? { navigate: openSourceRequest.navigate } : {}),
    })
  }, [openSourceRequest, vdr.isLoading])
  // El programa de la subida directa llega por un chunk aparte para no viajar
  // en el first-load JS de la sala. Se pide al montar, así que ya está cuando
  // el cliente suelta los archivos.
  useEffect(() => {
    warmDirectVdrUpload()
  }, [])

  // Sin dependencias a propósito: los efectos que lanzan estas dos cargas
  // dependen de `vdr` y de `onRetry`, que cambian en cada render, así que su
  // propia limpieza las mataría enseguida. Este corre una sola vez, al salir.
  useEffect(
    () => () => {
      const pendingClaim = claimRetryFiberRef.current
      claimRetryFiberRef.current = null
      if (pendingClaim) {
        claimRetryAttemptedRef.current = false
        pendingClaim.interruptUnsafe()
      }
      const pendingHandoff = handoffPeekFiberRef.current
      handoffPeekFiberRef.current = null
      if (pendingHandoff) {
        handoffArrivalRef.current = 'IDLE'
        pendingHandoff.interruptUnsafe()
      }
    },
    []
  )

  useEffect(() => {
    const mode = isDemo ? 'DEMO' : 'PERMANENT'
    trackSellSideEventOnce(
      'workspace_entered',
      { locale, mode },
      `${mode.toLowerCase()}:${companyId}`
    )
    if (!isDemo && !roomEnteredTrackedRef.current) {
      roomEnteredTrackedRef.current = true
      void trackRoomJourney('room_entered', {})
    }
  }, [companyId, isDemo, locale])

  const startIntakeClaim = useCallback(() => {
    if (isDemo || isReadOnly || adminOperator || claimRetryAttemptedRef.current) return
    claimRetryAttemptedRef.current = true
    const fiber = runClientFork(retryIntakeClaim(INTAKE_CSRF_HEADER))
    claimRetryFiberRef.current = fiber
    fiber.addObserver((exit) => {
      if (claimRetryFiberRef.current !== fiber) return
      claimRetryFiberRef.current = null
      if (!Exit.isSuccess(exit)) return
      document.cookie = `${INTAKE_CLAIM_RETRY_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`
      router.refresh()
    })
  }, [adminOperator, isDemo, isReadOnly, router])

  useEffect(() => {
    const prefix = `${INTAKE_CLAIM_RETRY_COOKIE}=`
    const retryMarker = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length)
    if (retryMarker === INTAKE_CLAIM_RETRY_MARKER) startIntakeClaim()
  }, [startIntakeClaim])

  useEffect(() => {
    if (!vdr.isLoading) return

    const timeout = window.setTimeout(() => setLoadingTimedOut(true), 12_000)
    return () => window.clearTimeout(timeout)
  }, [vdr.isLoading])

  useEffect(() => {
    if (handoffArrivalRef.current !== 'IDLE' || isReadOnly || adminOperator || vdr.isLoading) return
    handoffArrivalRef.current = 'READING'
    const fiber = runClientFork(readParkedHandoff())
    handoffPeekFiberRef.current = fiber
    fiber.addObserver((exit) => {
      if (handoffPeekFiberRef.current !== fiber) return
      handoffPeekFiberRef.current = null
      // Interrumpida al desmontar: no se encola nada ni se toca la URL de una
      // sala que ya no está.
      if (!Exit.isSuccess(exit)) return
      const handoff = exit.value
      const parkedName = isDemo ? null : handoff.companyName
      const hasParkedFiles = handoff.status === 'READY'
      if (!parkedName && !hasParkedFiles) {
        settleHandoffArrival()
        return
      }
      // El sobre pertenece a la visita que lo parqueó, no al navegador. Sin la
      // llave en la URL, o con otra, esta visita no lo aplica: subirlo le daría
      // archivos ajenos a quien haya entrado en este navegador. Pero tampoco lo
      // borra: la llave que no empareja puede ser la de otro flujo vivo — la
      // pestaña A aterriza con la suya y el sobre es el que parqueó la pestaña
      // B, que todavía va en camino a su propia sala. Solo se limpia la llave
      // de ESTA URL; el sobre lo cierra su TTL o el reclamo que sí le toca.
      if (!ownsParkedHandoff(handoff.nonce)) {
        runClientFork(
          Effect.logWarning('[vdr] handoff no reclamado: esta visita no trae la llave del sobre')
        )
        settleHandoffArrival()
        return
      }
      startIntakeClaim()
      // El nombre sobrevive a los bytes: una tanda temporal ya reconoció sus
      // archivos antes de que la sala abriera y el nombre todavía la tiene que
      // nombrar. Pero solo bautiza un alta nueva: un cliente que ya tenía sala
      // y volvió a la landing recibe sus archivos y conserva su nombre. La sala
      // demo no se renombra, igual que su botón de portada.
      // Corre al lado de la subida, no antes: el viaje a Convex del renombrado
      // no puede retrasar los documentos que el cliente ya soltó.
      if (parkedName) {
        if (companyBornFromHandoff({ companyCreatedAt, stashedAt: handoff.stashedAt })) {
          void renameCompany(parkedName).then((renamed) => {
            if (renamed) void ackHandoffCompanyName()
          })
        } else {
          runClientFork(
            Effect.logWarning(
              '[vdr] nombre del sobre descartado: el Data Room ya existía antes del intake'
            )
          )
          void ackHandoffCompanyName()
        }
      }
      if (!hasParkedFiles) {
        settleHandoffArrival()
        return
      }
      for (const item of handoff.files) handoffFileIdsRef.current.set(item.file, item.id)
      // El sobre viene del mismo gesto que el intake temporal: aterriza con el
      // nombre completo y ruteado por el nombre, no en la carpeta del diálogo.
      vdr.queueFiles(
        handoff.files.map((item) => item.file),
        'INTAKE_HANDOFF'
      )
      handoffArrivalRef.current = 'QUEUED'
    })
  }, [
    adminOperator,
    companyCreatedAt,
    isDemo,
    isReadOnly,
    locale,
    ownsParkedHandoff,
    renameCompany,
    settleHandoffArrival,
    startIntakeClaim,
    vdr,
  ])

  useEffect(() => {
    // `handleUpload` lee la cola del estado, no del ref, así que no puede correr
    // en el mismo tick que `queueFiles`.
    if (handoffArrivalRef.current === 'QUEUED' && vdr.uploadQueue.length > 0) {
      handoffArrivalRef.current = 'UPLOADING'
      void Promise.resolve(vdr.handleUpload()).finally(() => {
        handoffArrivalRef.current = 'SETTLING'
        markArrivalSettled()
      })
      return
    }
    // `handleUpload` ya cantó su resultado y dejó lo fallido en la cola. El
    // diálogo solo aparece para reintentar eso, nunca para pedir el archivo
    // que el cliente ya soltó en la landing.
    if (handoffArrivalRef.current === 'SETTLING') {
      // Recién aquí el sobre quedó consumido: los archivos se encolaron y la
      // subida cantó su resultado. La llave sale de la URL en este punto, no en
      // el peek — hasta ahora era lo único que dejaba recuperarlo tras un
      // reload.
      settleHandoffArrival()
      if (vdr.uploadQueue.some((entry) => entry.status === 'ERROR')) {
        vdr.setUploadDialogOpen(true)
      }
    }
  }, [arrivalSettleTick, settleHandoffArrival, vdr])

  if (loadingTimedOut && vdr.isLoading) {
    return (
      <VdrWorkspaceFailure
        locale={locale}
        onRetry={() => {
          setLoadingTimedOut(false)
          onRetry()
        }}
      />
    )
  }

  if (vdr.isLoading) {
    return (
      <div
        className={`${ROOM_SCREEN_CONTAINER_CLASS} ${DOCUMENTS_SCREEN_HEIGHT_CLASS} py-4 lg:overflow-hidden`}
        aria-busy="true"
      >
        <p className="sr-only" role="status" aria-live="polite">
          {pageIdentityCopy[locale].loading}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 data-page-identity data-replay-ui="true" className={PAGE_IDENTITY_CLASS}>
            {pageIdentityCopy[locale].title}
          </h1>
          <Skeleton className="h-4 w-48 max-w-full motion-reduce:animate-none" />
        </div>
        <div className="mt-4 space-y-5">
          <Skeleton className="h-28 motion-reduce:animate-none" />
          <Skeleton className="h-96 motion-reduce:animate-none" />
        </div>
      </div>
    )
  }

  return (
    // El unico `main` de la pagina es el del layout (`app/[locale]/layout.tsx`).
    // Esta pantalla vive dentro de el, asi que aqui va un contenedor: dos
    // landmarks `main` anidados dejan al lector de pantalla sin un solo destino
    // para «ir al contenido».
    <div className="bg-background">
      <div
        className={`${ROOM_SCREEN_CONTAINER_CLASS} ${DOCUMENTS_SCREEN_HEIGHT_CLASS} flex min-h-0 flex-col py-4 lg:overflow-hidden`}
      >
        {/* Una sola identidad de página: la sala es una por empresa, así que no
            hay selector que repita «Sala» ni «Biblioteca corporativa». */}
        <div className="shrink-0">
          <CompanyRoomHeader screens={isReadOnly ? ['documents'] : screens}>
            {isDemo ? (
              <p
                data-testid="local-demo-evidence"
                role="note"
                className="text-muted-foreground text-xs font-medium"
              >
                {demoRoomEvidenceCopy[locale]}
              </p>
            ) : null}
          </CompanyRoomHeader>
        </div>

        <div className="mt-4 flex min-h-0 min-w-0 flex-1 flex-col">
          {isReadOnly ? (
            <CompanyMemberDocumentIndex documents={vdr.documents} locale={locale} />
          ) : (
            <>
              <RoomShell
                navigationRef={roomNavigationRef}
                coverActions={
                  <>
                    {activityHref ? (
                      <Button
                        variant="outline"
                        asChild
                        className="h-10 max-sm:w-10 max-sm:min-w-10 max-sm:px-0"
                      >
                        <Link
                          href={activityHref}
                          aria-label={copy.viewActivity}
                          title={copy.viewActivity}
                        >
                          <Activity className="h-4 w-4 sm:mr-2" aria-hidden="true" />
                          <span className="sr-only sm:not-sr-only sm:inline">
                            {copy.viewActivity}
                          </span>
                        </Link>
                      </Button>
                    ) : null}
                    <div title={copy.uploadDocument}>
                      <VdrUploadDialog
                        copy={copy}
                        locale={locale}
                        roomTitle={vdr.activeRoomTitle}
                        versionOfName={vdr.replacingDocument?.name}
                        open={vdr.uploadDialogOpen && !vdr.pendingForeignDrop}
                        onOpenChange={(open) => {
                          if (!vdr.pendingForeignDrop) vdr.setUploadDialogOpen(open)
                        }}
                        fileInputRef={vdr.fileInputRef}
                        selectedFile={vdr.selectedFile}
                        uploadQueue={vdr.uploadQueue}
                        allowMultiple={vdr.allowMultipleUpload}
                        docName={vdr.docName}
                        folder={vdr.folder}
                        accessLevel={vdr.accessLevel}
                        classification={vdr.classification}
                        isUploading={vdr.isUploading}
                        singleUploadReconciliationRequired={vdr.singleUploadReconciliationRequired}
                        onFileSelect={(...args) => void vdr.handleFileSelect(...args)}
                        onNameChange={vdr.setDocName}
                        onFolderChange={vdr.setFolder}
                        onAccessChange={vdr.setAccessLevel}
                        onClassificationChange={vdr.setClassification}
                        onCancel={vdr.resetUpload}
                        onStop={vdr.stopUploads}
                        onRemoveFile={vdr.removeQueuedFile}
                        onUpload={(...args) => void vdr.handleUpload(...args)}
                      />
                    </div>
                  </>
                }
                locale={locale}
                companyName={displayedCompanyName}
                companyLogoUrl={companyLogoUrl}
                companyMandate={companyMandate}
                documents={vdr.documents}
                isDemo={isDemo}
                search={vdr.search}
                onSearchChange={vdr.setSearch}
                onRename={(documentId) => {
                  const document = findDocument(documentId)
                  if (document) vdr.beginEdit(document)
                }}
                onArchive={(documentId) => {
                  const document = findDocument(documentId)
                  if (document) vdr.setDeleting(document)
                }}
                onPurge={(documentId) => void vdr.purgeDocuments([documentId])}
                onNewVersion={(documentId) => {
                  const document = findDocument(documentId)
                  if (document) vdr.startVersionUpload(document)
                }}
                onMove={vdr.moveDocumentToFolder}
                onMoveDocuments={vdr.moveDocuments}
                onRenameDocument={vdr.renameDocument}
                onRenameCompany={isDemo ? undefined : renameCompany}
                onQueueForeignFiles={vdr.queueForeignFiles}
                onActiveFolderChange={vdr.setActiveRoomFolder}
                pendingForeignDrop={vdr.pendingForeignDrop}
                onConfirmForeignDrop={vdr.confirmForeignDrop}
                onCancelForeignDrop={vdr.cancelForeignDrop}
                onOpenVersionHistory={(documentId) => {
                  const document = findDocument(documentId)
                  if (document) vdr.setVersionHistoryDocument(document)
                }}
                bulkSelection={{
                  selectedIds: vdr.selectedDocumentIds,
                  isUpdating: vdr.isBulkUpdating,
                  onToggle: vdr.toggleDocumentSelection,
                  onSelectMany: (documentIds, selected) =>
                    vdr.selectAllFilteredDocuments([...documentIds], selected),
                  onClear: vdr.clearDocumentSelection,
                  onMove: vdr.bulkMoveDocuments,
                  onChangeDisclosure: vdr.bulkChangeDisclosure,
                  onArchive: vdr.bulkArchiveDocuments,
                  onPurge: vdr.bulkPurgeDocuments,
                }}
                activityHref={activityHref}
              />
            </>
          )}
        </div>
      </div>

      {!isReadOnly ? (
        <>
          <VdrEditDialog
            copy={copy}
            locale={locale}
            open={vdr.editOpen}
            onOpenChange={vdr.setEditOpen}
            document={vdr.editing}
            adminOperator={adminOperator}
            name={vdr.editName}
            folder={vdr.editFolder}
            accessLevel={vdr.editAccess}
            expiresAt={vdr.editExpiresAt}
            isSaving={vdr.isSavingEdit}
            onNameChange={vdr.setEditName}
            onFolderChange={vdr.setEditFolder}
            onAccessChange={vdr.setEditAccess}
            onExpiresAtChange={vdr.setEditExpiresAt}
            onSave={(...args) => void vdr.saveEdit(...args)}
          />
          <VdrDeleteDialog
            copy={copy}
            open={vdr.deleteOpen}
            onOpenChange={vdr.setDeleteOpen}
            documentName={vdr.deleting?.name}
            isTeamDelivery={vdr.deleting?.sourceType === 'TEAM_DELIVERABLE'}
            isDeleting={vdr.isDeleting}
            onDelete={(...args) => void vdr.deleteDocument(...args)}
          />
          <VdrDocumentVersionsDialog
            document={vdr.versionHistoryDocument}
            locale={locale}
            onOpenChange={(open) => {
              if (!open) vdr.setVersionHistoryDocument(null)
            }}
          />
        </>
      ) : null}
    </div>
  )
}
