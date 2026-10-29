'use client'

import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { useTranslations } from 'next-intl'
import { Effect, Exit, Schema } from 'effect'

import type { Id } from '@/../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { ConvexLoadFailure } from './vdr/ConvexLoadFailure'
import { useConvexLoadTimeout } from './vdr/useConvexLoadTimeout'
import { Textarea } from '@/components/ui/textarea'
import { trackSellSideEventOnce } from '@/lib/analytics/sell-side'
import { runClientEffectExit, runClientFork } from '@/lib/effect/client-runtime'
import { cn, formatDateTime } from '@/lib/utils'

// ===== LA COSTURA CON EFFECT =====
// Mandar un mensaje y marcar el hilo como leído son dos programas con nombre.
// El segundo importa más de lo que parece: se disparaba con
// `void markRead(...).catch(() => undefined)`, o sea sin dueño — nadie lo
// cancelaba al desmontar y su fallo se tragaba sin dejar rastro. Ahora es una
// fibra que el `useEffect` interrumpe en su limpieza.
type PaginationOpts = { numItems: number; cursor: string | null }
type SupportMessage = {
  messageId: Id<'supportMessages'>
  sequence: number
  authorKind: 'COMPANY' | 'ADMIN' | 'INTAKE'
  body: string
  createdAt: number
}
type PaginatedMessages = {
  page: SupportMessage[]
  isDone: boolean
  continueCursor: string
}
type CompanyThreadSummary = {
  threadId: Id<'supportThreads'> | null
  canSend: boolean
  unreadCount: number
  lastSequence: number
}

const getCompanyThreadRef = makeFunctionReference<
  'query',
  { companyId: Id<'companies'> },
  CompanyThreadSummary
>('support:getCompanyThread')

const listCompanyMessagesRef = makeFunctionReference<
  'query',
  { companyId: Id<'companies'>; paginationOpts: PaginationOpts },
  PaginatedMessages
>('support:listCompanyMessages')

const sendCompanyMessageRef = makeFunctionReference<
  'mutation',
  { companyId: Id<'companies'>; body: string },
  { threadId: Id<'supportThreads'>; messageId: Id<'supportMessages'>; sequence: number }
>('support:sendCompanyMessage')

const markCompanyThreadReadRef = makeFunctionReference<
  'mutation',
  { companyId: Id<'companies'>; throughSequence: number },
  { marked: boolean }
>('support:markCompanyThreadRead')

class SupportSendFailed extends Schema.TaggedError<SupportSendFailed>()('SupportSendFailed', {
  cause: Schema.Defect(),
}) {}

const sendSupportMessage = Effect.fn('Support.sendCompanyMessage')(function* (
  send: (args: { companyId: Id<'companies'>; body: string }) => Promise<unknown>,
  args: { companyId: Id<'companies'>; body: string }
): Effect.fn.Return<void, SupportSendFailed> {
  yield* Effect.tryPromise({
    try: () => send(args),
    catch: (cause) => new SupportSendFailed({ cause }),
  })
})

/**
 * Marcar el hilo leído es acuse de recibo, no una acción del cliente: si falla
 * no hay nada que decirle. Lo que sí importa es que tenga dueño — la fibra se
 * interrumpe cuando el componente se va o cuando cambia el hilo.
 */
const markSupportThreadRead = Effect.fn('Support.markThreadRead')(
  function* (
    markRead: (args: { companyId: Id<'companies'>; throughSequence: number }) => Promise<unknown>,
    args: { companyId: Id<'companies'>; throughSequence: number }
  ): Effect.fn.Return<void, SupportSendFailed> {
    // `tryPromise` y no `promise`: un rechazo tiene que quedar en el canal de
    // error para que `ignore` lo trague, no volverse un defecto que la fibra
    // reporte por su cuenta.
    yield* Effect.tryPromise({
      try: () => markRead(args),
      catch: (cause) => new SupportSendFailed({ cause }),
    })
  },
  // `Effect.ignore` no sirve como combinador pelado: con argumentos extra,
  // Effect.fn se los pasa y el overload los toma por `options`.
  (program) => Effect.ignore(program)
)

export type SupportThreadProps = {
  companyId: Id<'companies'>
  className?: string
  isDemo?: boolean
}

export function SupportThread(props: SupportThreadProps) {
  const [attempt, setAttempt] = useState(0)
  return (
    <SupportThreadLive
      key={`${props.companyId}:${attempt}`}
      {...props}
      onRetry={() => {
        setAttempt((current) => current + 1)
      }}
    />
  )
}

function SupportThreadLive({
  companyId,
  className,
  isDemo = false,
  onRetry,
}: SupportThreadProps & { onRetry: () => void }) {
  const t = useTranslations('support')
  const vdr = useTranslations('vdr')
  const liveSummary = useQuery(getCompanyThreadRef, isDemo ? 'skip' : { companyId })
  const {
    results: paginatedMessages,
    status,
    loadMore,
  } = usePaginatedQuery(listCompanyMessagesRef, isDemo ? 'skip' : { companyId }, {
    initialNumItems: 30,
  })
  const sendMessage = useMutation(sendCompanyMessageRef)
  const markRead = useMutation(markCompanyThreadReadRef)
  const loadTimeout = useConvexLoadTimeout(
    !isDemo && (liveSummary === undefined || status === 'LoadingFirstPage'),
    12_000,
    companyId
  )
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentNotice, setSentNotice] = useState(false)
  const [demoMessages, setDemoMessages] = useState<SupportMessage[]>([])
  const summary = useMemo(
    () =>
      isDemo
        ? { threadId: null, canSend: true, unreadCount: 0, lastSequence: demoMessages.length }
        : liveSummary,
    [demoMessages.length, isDemo, liveSummary]
  )

  const messages = useMemo(
    () => (isDemo ? demoMessages : [...paginatedMessages].reverse()),
    [demoMessages, isDemo, paginatedMessages]
  )
  useEffect(() => {
    const mode = isDemo ? 'DEMO' : 'PERMANENT'
    trackSellSideEventOnce(
      'support_opened',
      { locale: 'es', mode },
      `${mode.toLowerCase()}:${companyId}`
    )
  }, [companyId, isDemo])

  useEffect(() => {
    if (!summary || summary.unreadCount === 0 || summary.lastSequence === 0) return
    const fiber = runClientFork(
      markSupportThreadRead(markRead, { companyId, throughSequence: summary.lastSequence })
    )
    return () => fiber.interruptUnsafe()
  }, [companyId, markRead, summary])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextBody = body.trim()
    if (!nextBody || submitting || summary?.canSend !== true) return
    if (isDemo) {
      setDemoMessages((current) => [
        ...current,
        {
          messageId: `demo-support-${current.length + 1}` as Id<'supportMessages'>,
          sequence: current.length + 1,
          authorKind: 'COMPANY',
          body: nextBody,
          createdAt: Date.now(),
        },
      ])
      setBody('')
      return
    }

    setSubmitting(true)
    setError(null)
    setSentNotice(false)
    const exit = await runClientEffectExit(
      sendSupportMessage(sendMessage, { companyId, body: nextBody })
    )
    setSubmitting(false)

    if (Exit.isSuccess(exit)) {
      setBody('')
      setSentNotice(true)
      return
    }
    setError(t('sendError'))
  }

  return (
    <section
      id="company-support"
      aria-labelledby="company-support-heading"
      className={cn(className)}
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="company-support-heading">{t('title')}</h2>
        <p className="text-muted-foreground text-sm">{t('description')}</p>
      </div>
      <div className="mt-4 space-y-4">
        {isDemo ? <p className="text-muted-foreground text-sm">{t('demoNotice')}</p> : null}
        {loadTimeout.timedOut ? (
          <ConvexLoadFailure
            message={vdr('loadFailed')}
            onRetry={onRetry}
            testId="support-thread-load-failure"
          />
        ) : !isDemo && status === 'LoadingFirstPage' ? (
          <p className="text-muted-foreground text-sm">{t('loading')}</p>
        ) : messages.length > 0 ? (
          <ol
            className="divide-border border-border max-h-96 divide-y overflow-y-auto border-y"
            aria-live="polite"
          >
            {messages.map((message) => (
              <li key={message.messageId} className="py-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-xs font-semibold">
                    {message.authorKind === 'ADMIN' ? t('author.team') : t('author.company')}
                  </p>
                  <time
                    className="text-muted-foreground font-figure text-xs"
                    dateTime={new Date(message.createdAt).toISOString()}
                  >
                    {formatDateTime(message.createdAt)}
                  </time>
                </div>
                <p className="mt-1 text-sm leading-6 break-words whitespace-pre-wrap">
                  {message.body}
                </p>
              </li>
            ))}
          </ol>
        ) : null}

        {!isDemo && (status === 'CanLoadMore' || status === 'LoadingMore') ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={status === 'LoadingMore'}
            onClick={() => loadMore(30)}
          >
            {status === 'LoadingMore' ? t('loadingMore') : t('loadMore')}
          </Button>
        ) : null}

        {summary?.canSend === false ? (
          <p className="text-muted-foreground text-sm">{t('readOnly')}</p>
        ) : summary?.canSend === true ? (
          <form className="space-y-3" onSubmit={(...args) => void handleSubmit(...args)}>
            <label htmlFor="company-support-message" className="sr-only">
              {t('messageLabel')}
            </label>
            <Textarea
              id="company-support-message"
              value={body}
              rows={3}
              placeholder={t('placeholder')}
              disabled={submitting}
              onChange={(event) => {
                setBody(event.target.value)
                if (sentNotice) setSentNotice(false)
              }}
            />
            {error ? (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" disabled={submitting || body.trim().length === 0}>
                {submitting ? t('sending') : t('send')}
              </Button>
              <p role="status" className="text-muted-foreground text-sm">
                {sentNotice ? t('sent') : ''}
              </p>
            </div>
            {/* Qué pasa al pulsar Enviar, dicho antes de pulsarlo: el mensaje
                le llega al equipo por correo y la respuesta vuelve a este
                mismo hilo. */}
            <p className="text-muted-foreground text-sm">{t('composerHint')}</p>
          </form>
        ) : null}
      </div>
    </section>
  )
}
