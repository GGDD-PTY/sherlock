'use client'

import { useState, useSyncExternalStore } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useTranslations } from 'next-intl'
import { Effect, Schema } from 'effect'
import { ChevronUp } from 'lucide-react'

import { api } from '@/../convex/_generated/api'
import { extractConvexErrorCode } from '@/components/shared/convex-error-code'
import {
  VOTABLE_STATUSES,
  type RoadmapEntry,
  type RoadmapStatus,
} from '@/../convex/_roadmap/registry'
import { getRoadmapDeviceToken } from '@/lib/roadmap/device-token'
import { runClientEffect } from '@/lib/effect/client-runtime'

export type RoadmapCard = {
  key: string
  status: RoadmapStatus
  board: RoadmapEntry['board']
  added: string
  title: string
  body: string
  statusLabel: string
  // El aria del control llega ya formateado por tarjeta desde el servidor. Un
  // `labels.voteAria.replace('{title}', …)` en el cliente parecía equivalente y
  // no lo era: next-intl corre el mensaje por ICU y, sin el valor `title`, tira
  // FORMATTING_ERROR y devuelve la RUTA DE LA CLAVE — el botón se anunciaba
  // literalmente "roadmap.board.voteAria" en producción.
  voteAria: string
  unvoteAria: string
}

export type RoadmapBoardLabels = {
  sortTop: string
  sortNew: string
  filterAll: string
  filterFeature: string
  filterBug: string
  sortGroup: string
  filterGroup: string
  emptyBug: string
  votesCapReached: string
  votedHint: string
  doingColumn: string
  doneColumn: string
}

type SortKey = 'top' | 'new'
type BoardFilter = 'all' | RoadmapEntry['board']

class RoadmapVoteFailed extends Schema.TaggedError<RoadmapVoteFailed>()('RoadmapVoteFailed', {
  cause: Schema.Defect(),
}) {}

/** Votar es una acción que se pudo o no se pudo; el detalle se queda en consola. */
const castVote = Effect.fn('Roadmap.vote')(function* (
  send: () => Promise<unknown>
): Effect.fn.Return<boolean> {
  return yield* Effect.tryPromise({
    try: send,
    catch: (cause) => new RoadmapVoteFailed({ cause }),
  }).pipe(
    Effect.as(true),
    Effect.catch((failure) =>
      Effect.logError('[roadmap] vote failed', extractConvexErrorCode(failure.cause)).pipe(
        Effect.as(false)
      )
    )
  )
})

// Un solo estilo de chip: el estado lo dice la etiqueta, no el tono ni el
// trazo (antes había cuatro combinaciones de relleno/borde punteado).
const STATUS_CHIP =
  'border-border-hairline text-muted-foreground inline-block shrink-0 rounded-sm border px-2 py-0.5 text-xs leading-5'

// Control segmentado: el activo se lee por relleno `secondary` y texto
// completo, nunca por un píldora rellena en primario/ocre.
const SEGMENT_GROUP = 'border-border inline-flex items-center gap-0.5 rounded-md border p-0.5'
const SEGMENT_BASE =
  'focus-visible:ring-ring/50 inline-flex h-8 items-center rounded-sm px-3 text-sm font-medium outline-none transition-colors duration-[120ms] focus-visible:ring-[3px] motion-reduce:transition-none'
const SEGMENT_ON = 'bg-secondary text-foreground'
const SEGMENT_OFF = 'text-muted-foreground hover:text-foreground'

const VOTE_BASE =
  'focus-visible:ring-ring/50 flex w-12 shrink-0 flex-col items-center gap-0.5 rounded-md border px-2 py-1.5 outline-none transition-colors duration-[120ms] focus-visible:ring-[3px] disabled:opacity-60 motion-reduce:transition-none'
// El voto puesto se lee por relleno y borde, no sólo por color: `aria-pressed`
// lo dice a la asistiva, y el relleno lo dice a quien no distingue el acento
// del texto apagado.
const VOTE_ON = 'border-primary bg-secondary text-foreground'
const VOTE_OFF = 'border-border text-muted-foreground hover:text-foreground'

const CARD_TITLE = 'font-sans text-sm leading-snug font-semibold'
const HAIRLINE_ROWS = 'border-border-hairline divide-border-hairline divide-y border-y'

function StatusChip({ card }: { card: RoadmapCard }) {
  return <span className={STATUS_CHIP}>{card.statusLabel}</span>
}

// Las pilas congeladas no repiten el chip: el eyebrow de la columna ya nombra
// el estado de cada fila.
function FrozenStack({
  testId,
  heading,
  cards,
  votesCount,
  voteCount,
}: {
  testId: string
  heading: string
  cards: readonly RoadmapCard[]
  votesCount: (count: number) => string
  voteCount: (key: string) => number
}) {
  return (
    <section data-testid={testId} className="grid content-start gap-3">
      <h2 className="eyebrow">{heading}</h2>
      <ul className={HAIRLINE_ROWS}>
        {cards.map((card) => {
          const count = voteCount(card.key)
          return (
            <li key={card.key} className="flex items-center gap-3 py-1">
              <h2 className={`${CARD_TITLE} min-w-0 flex-1`}>{card.title}</h2>
              <span
                className="font-figure text-muted-foreground shrink-0 text-xs"
                aria-hidden="true"
              >
                {count}
              </span>
              <span className="sr-only">{votesCount(count)}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// El token de dispositivo se genera una vez y no cambia mientras la página vive,
// así que no hay evento al que suscribirse. React exige la función igual.
function subscribeToRoadmapDeviceToken(): () => void {
  return () => {}
}

export function RoadmapBoard({
  cards,
  labels,
}: {
  cards: readonly RoadmapCard[]
  labels: RoadmapBoardLabels
}) {
  // Todo el resto de la copia llega ya formateada desde el servidor por `labels`.
  // El conteo no puede: su valor solo existe en el cliente, y "1 votos" es
  // incorrecto en los dos idiomas. Este es el unico string que se formatea aqui.
  const t = useTranslations('roadmap.board')
  const [sort, setSort] = useState<SortKey>('top')
  const [board, setBoard] = useState<BoardFilter>('all')
  const [pending, setPending] = useState<string | null>(null)
  const [voteFailed, setVoteFailed] = useState(false)

  // localStorage no existe durante el render del servidor, así que el token se
  // lee después de montar. Hasta entonces la query de votos propios se salta:
  // pedirla con un token vacío devolvería "no has votado nada", que es
  // indistinguible de la verdad y pintaría los botones mal por un instante.
  // `useSyncExternalStore` en vez de un efecto que hace setState: leer
  // localStorage es leer un almacén externo, que es justo para lo que existe
  // esta API. El snapshot del servidor es `null`, así que la hidratación no
  // difiere, y no hay render encadenado que `react-hooks/set-state-in-effect`
  // prohíba.
  const deviceToken = useSyncExternalStore(
    subscribeToRoadmapDeviceToken,
    getRoadmapDeviceToken,
    () => null
  )

  const totals = useQuery(api.roadmap.getVoteTotals)
  const myVotes = useQuery(
    api.roadmap.getDeviceVotes,
    deviceToken === null ? 'skip' : { deviceToken }
  )
  const vote = useMutation(api.roadmap.vote)

  const voteCount = (key: string) => totals?.[key] ?? 0
  const formatVotesCount = (count: number) => t('votesCount', { count })
  const votedKeys = new Set(myVotes?.featureKeys ?? [])
  const budgetSpent = myVotes !== undefined && myVotes.remaining === 0

  // Array#sort is stable, so `top` falls back to registry order when two cards
  // hold the same live total, without a synthetic tie-break key.
  const sorts: Record<SortKey, (a: RoadmapCard, b: RoadmapCard) => number> = {
    top: (a, b) => voteCount(b.key) - voteCount(a.key),
    new: (a, b) => b.added.localeCompare(a.added) || voteCount(b.key) - voteCount(a.key),
  }

  const votable = cards.filter((card) => VOTABLE_STATUSES.includes(card.status))
  const visible = board === 'all' ? votable : votable.filter((card) => card.board === board)
  const ordered = [...visible].sort(sorts[sort])

  const sortTabs: { key: SortKey; label: string }[] = [
    { key: 'top', label: labels.sortTop },
    { key: 'new', label: labels.sortNew },
  ]

  const boardFilters: { key: BoardFilter; label: string }[] = [
    { key: 'all', label: labels.filterAll },
    { key: 'feature', label: labels.filterFeature },
    { key: 'bug', label: labels.filterBug },
  ]

  async function toggleVote(card: RoadmapCard) {
    if (deviceToken === null) return

    setVoteFailed(false)
    setPending(card.key)
    const voted = await runClientEffect(castVote(() => vote({ featureKey: card.key, deviceToken })))
    if (!voted) setVoteFailed(true)
    // El estado del botón lo dicta `getDeviceVotes`, que es reactiva: no se
    // guarda una copia local del resultado porque divergiría del servidor en
    // cuanto el visitante abra la página en dos pestañas.
    setPending(null)
  }

  return (
    // Sin riel lateral: el tablero ya vive en la columna derecha del hub
    // (7/12 de 72rem) y un riel dentro de esa columna dejaba el backlog en
    // ~250px. Las pilas congeladas van debajo, a dos columnas desde sm, como
    // bloque compacto — no como columna suelta.
    <div className="grid gap-8">
      <div data-testid="roadmap-backlog" className="grid content-start gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div role="group" aria-label={labels.sortGroup} className={SEGMENT_GROUP}>
            {sortTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                aria-pressed={sort === tab.key}
                onClick={() => setSort(tab.key)}
                className={`${SEGMENT_BASE} ${sort === tab.key ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div role="group" aria-label={labels.filterGroup} className={SEGMENT_GROUP}>
            {boardFilters.map((filter) => (
              <button
                key={filter.key}
                type="button"
                aria-pressed={board === filter.key}
                onClick={() => setBoard(filter.key)}
                className={`${SEGMENT_BASE} ${board === filter.key ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {ordered.length === 0 ? (
          <p className="border-border-hairline text-muted-foreground border-y py-6 text-sm leading-relaxed">
            {labels.emptyBug}
          </p>
        ) : (
          <ul className={HAIRLINE_ROWS}>
            {ordered.map((card) => {
              const voted = votedKeys.has(card.key)
              // El presupuesto agotado sólo bloquea lo que NO está votado:
              // quitar un voto tiene que seguir siendo posible, o el visitante
              // que gastó los tres queda encerrado en su primera elección.
              const locked = !voted && budgetSpent
              const disabled = locked || pending === card.key || deviceToken === null

              return (
                <li key={card.key} className="flex items-center gap-4 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <h2 className={CARD_TITLE}>{card.title}</h2>
                      <StatusChip card={card} />
                    </div>
                    <p
                      className="text-muted-foreground mt-0.5 text-sm leading-relaxed sm:line-clamp-1"
                      title={card.body}
                    >
                      {card.body}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label={voted ? card.unvoteAria : card.voteAria}
                    aria-pressed={voted}
                    title={locked ? labels.votesCapReached : undefined}
                    disabled={disabled}
                    onClick={() => void toggleVote(card)}
                    className={`${VOTE_BASE} ${voted ? VOTE_ON : VOTE_OFF}`}
                  >
                    <ChevronUp className="h-4 w-4" aria-hidden="true" />
                    <span className="font-figure text-sm font-semibold">{voteCount(card.key)}</span>
                  </button>
                  {/* Fuera del botón: su `aria-label` suprime todo texto interno,
                      así que dentro el conteo nunca se anunciaría. */}
                  <span className="sr-only">
                    {t('votesCount', { count: voteCount(card.key) })}
                    {voted ? `. ${labels.votedHint}` : ''}
                    {locked ? `. ${labels.votesCapReached}` : ''}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        {voteFailed ? (
          <p role="alert" className="text-destructive text-sm">
            {t('voteError')}
          </p>
        ) : null}

        {budgetSpent ? (
          <p className="text-muted-foreground text-sm leading-relaxed">{labels.votesCapReached}</p>
        ) : null}
      </div>

      <div className="grid content-start gap-6 sm:grid-cols-2 sm:gap-x-8">
        <FrozenStack
          testId="roadmap-doing"
          heading={labels.doingColumn}
          cards={cards.filter((card) => card.status === 'inProgress')}
          votesCount={formatVotesCount}
          voteCount={voteCount}
        />
        <FrozenStack
          testId="roadmap-done"
          heading={labels.doneColumn}
          cards={cards.filter((card) => card.status === 'shipped')}
          votesCount={formatVotesCount}
          voteCount={voteCount}
        />
      </div>
    </div>
  )
}
