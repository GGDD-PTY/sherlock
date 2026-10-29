'use client'

// ============================================================================
// BANDEJA DE SOPORTE DEL EQUIPO
// ============================================================================
// Leer los mensajes de un hilo es una MUTATION, no una query: la lectura queda
// auditada. Por eso este archivo tiene su propio paginador a mano en vez de
// `usePaginatedQuery`, y por eso tenía tres banderas `cancelled` y un
// `loadingRef` coordinando promesas sueltas.
//
// Ahora cada carga es un programa con nombre que corre en una fibra guardada en
// un ref: al cambiar de hilo o al desmontar, la fibra se interrumpe y su Exit
// interrumpido no pinta estado. Las banderas se van con ella —eran un
// mecanismo de cancelación que no cancelaba nada, solo descartaba el resultado
// cuando ya había llegado.
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, usePaginatedQuery, useQuery } from 'convex/react'
import { makeFunctionReference } from 'convex/server'
import { Effect } from 'effect'
import type { Fiber } from 'effect'
import { MessageSquareText, Send } from 'lucide-react'
import { useLocale, useTranslations } from 'next-intl'

import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import type { Id } from '@/../convex/_generated/dataModel'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/i18n/navigation'
import { runClientEffect, runClientFork } from '@/lib/effect/client-runtime'
import { formatDateTime } from '@/lib/utils'

const MESSAGE_MAX_LENGTH = 2_000

type PaginationOpts = { numItems: number; cursor: string | null }

type SupportMessage = {
  messageId: Id<'supportMessages'>
  sequence: number
  authorKind: 'COMPANY' | 'ADMIN' | 'INTAKE'
  body: string
  createdAt: number
}
type InboxItem = {
  threadId: Id<'supportThreads'>
  roomLabel: string | null
  scopeKind: 'COMPANY' | 'INTAKE'
  companyId: Id<'companies'> | null
  intakeSessionId: Id<'intakeSessions'> | null
  unreadCount: number
  lastMessageAt: number
}
type ThreadSummary = {
  threadId: Id<'supportThreads'> | null
  roomLabel: string | null
  scopeKind: 'COMPANY' | 'INTAKE'
  companyId: Id<'companies'> | null
  intakeSessionId: Id<'intakeSessions'> | null
  canSend: boolean
  unreadCount: number
  lastSequence: number
}
type Paginated<T> = { page: T[]; isDone: boolean; continueCursor: string }
type AdminSelection = {
  threadId?: Id<'supportThreads'>
  companyId?: Id<'companies'>
  intakeSessionId?: Id<'intakeSessions'>
}

const listAdminInboxRef = makeFunctionReference<
  'query',
  { paginationOpts: PaginationOpts },
  Paginated<InboxItem>
>('support:listAdminInbox')

const getAdminThreadRef = makeFunctionReference<'query', AdminSelection, ThreadSummary>(
  'support:getAdminThread'
)

const listAdminMessagesRef = makeFunctionReference<
  'mutation',
  AdminSelection & { paginationOpts: PaginationOpts },
  Paginated<SupportMessage>
>('support:listAdminMessages')

const sendAdminMessageRef = makeFunctionReference<
  'mutation',
  AdminSelection & { body: string },
  { threadId: Id<'supportThreads'>; messageId: Id<'supportMessages'>; sequence: number }
>('support:sendAdminMessage')

const markAdminThreadReadRef = makeFunctionReference<
  'mutation',
  { threadId: Id<'supportThreads'>; throughSequence: number },
  { marked: boolean }
>('support:markAdminThreadRead')

export type AdminSupportInboxProps = {
  selectedThreadId?: string
  selectedCompanyId?: string
  selectedIntakeId?: string
}

type AuditedMessageStatus =
  'LoadingFirstPage' | 'CanLoadMore' | 'LoadingMore' | 'Exhausted' | 'Error'

type ReadMessages = (
  args: AdminSelection & { paginationOpts: PaginationOpts }
) => Promise<Paginated<SupportMessage>>

/** Una página de la lectura auditada, con su paso nombrado. */
const readMessagePage = Effect.fn('AdminSupport.readMessages')(function* (
  read: ReadMessages,
  selection: AdminSelection,
  paginationOpts: PaginationOpts
): Effect.fn.Return<Paginated<SupportMessage>, AdminActionError> {
  return yield* adminStep(
    'AdminSupport.readMessages',
    'support.listAdminMessages',
    'support.listAdminMessages',
    () => read({ ...selection, paginationOpts })
  )
})

function selectionKey(selection: AdminSelection | null): string | null {
  if (!selection) return null
  return `${selection.threadId ?? ''}:${selection.companyId ?? ''}:${selection.intakeSessionId ?? ''}`
}

type AuditedMessageState = {
  key: string | null
  results: SupportMessage[]
  status: AuditedMessageStatus
  continueCursor: string | null
  hasError: boolean
}

function useAuditedAdminMessages(selection: AdminSelection | null) {
  const readMessages = useMutation(listAdminMessagesRef)
  const key = selectionKey(selection)
  const [state, setState] = useState<AuditedMessageState>(() => ({
    key,
    results: [],
    status: selection ? 'LoadingFirstPage' : 'Exhausted',
    continueCursor: null,
    hasError: false,
  }))
  const [refreshToken, setRefreshToken] = useState(0)
  const loadingRef = useRef(false)
  // La fibra en vuelo: es lo que se interrumpe al cambiar de hilo o desmontar.
  const fiberRef = useRef<Fiber.Fiber<void> | null>(null)
  const visibleState: AuditedMessageState =
    state.key === key
      ? state
      : {
          key,
          results: [],
          status: selection ? 'LoadingFirstPage' : 'Exhausted',
          continueCursor: null,
          hasError: false,
        }
  const visibleStatus = visibleState.status
  const visibleCursor = visibleState.continueCursor

  useEffect(() => {
    // Una carga nueva reemplaza a la anterior: la fibra vieja se interrumpe.
    fiberRef.current?.interruptUnsafe()
    fiberRef.current = null
    loadingRef.current = false

    if (!selection) return

    loadingRef.current = true
    const fiber = runClientFork(
      readMessagePage(readMessages, selection, { cursor: null, numItems: 30 }).pipe(
        Effect.tap((page) =>
          Effect.sync(() =>
            setState({
              key,
              results: page.page,
              continueCursor: page.continueCursor,
              status: page.isDone ? 'Exhausted' : 'CanLoadMore',
              hasError: false,
            })
          )
        ),
        Effect.catch(() =>
          Effect.sync(() =>
            setState({
              key,
              results: [],
              continueCursor: null,
              status: 'Error',
              hasError: true,
            })
          )
        ),
        // `ensuring` no corre en un Exit interrumpido, así que la bandera se
        // limpia acá y en el cleanup.
        Effect.tap(() => Effect.sync(() => (loadingRef.current = false))),
        Effect.asVoid
      )
    )
    fiberRef.current = fiber

    return () => {
      fiber.interruptUnsafe()
      if (fiberRef.current === fiber) fiberRef.current = null
      loadingRef.current = false
    }
  }, [key, readMessages, refreshToken, selection])

  const reload = useCallback(() => {
    if (!selection) return
    setRefreshToken((current) => current + 1)
  }, [selection])

  const loadMore = useCallback(
    (numItems = 30) => {
      if (!selection || visibleStatus !== 'CanLoadMore' || !visibleCursor || loadingRef.current) {
        return
      }

      const cursor = visibleCursor
      loadingRef.current = true
      setState((current) =>
        current.key === key ? { ...current, status: 'LoadingMore', hasError: false } : current
      )
      // La página siguiente pertenece a la misma selección: si el usuario
      // cambia de hilo mientras carga, la fibra del efecto de arriba interrumpe
      // ésta también, porque `setState` compara `current.key`.
      void runClientEffect(
        readMessagePage(readMessages, selection, { cursor, numItems }).pipe(
          Effect.tap((page) =>
            Effect.sync(() =>
              setState((current) =>
                current.key === key
                  ? {
                      ...current,
                      results: [...current.results, ...page.page],
                      continueCursor: page.continueCursor,
                      status: page.isDone ? 'Exhausted' : 'CanLoadMore',
                      hasError: false,
                    }
                  : current
              )
            )
          ),
          Effect.catch(() =>
            Effect.sync(() =>
              setState((current) =>
                current.key === key
                  ? { ...current, status: 'CanLoadMore', hasError: true }
                  : current
              )
            )
          ),
          Effect.ensuring(Effect.sync(() => (loadingRef.current = false)))
        )
      )
    },
    [key, readMessages, selection, visibleCursor, visibleStatus]
  )

  return {
    results: visibleState.results,
    status: visibleState.status,
    loadMore,
    hasError: visibleState.hasError,
    reload,
  }
}

export function AdminSupportInbox({
  selectedThreadId,
  selectedCompanyId,
  selectedIntakeId,
}: AdminSupportInboxProps) {
  const t = useTranslations('support.admin')
  const locale = useLocale()
  const selection = useMemo<AdminSelection | null>(
    () =>
      selectedThreadId
        ? { threadId: selectedThreadId as Id<'supportThreads'> }
        : selectedCompanyId
          ? { companyId: selectedCompanyId as Id<'companies'> }
          : selectedIntakeId
            ? { intakeSessionId: selectedIntakeId as Id<'intakeSessions'> }
            : null,
    [selectedCompanyId, selectedIntakeId, selectedThreadId]
  )
  const {
    results: inbox,
    status: inboxStatus,
    loadMore: loadMoreInbox,
  } = usePaginatedQuery(listAdminInboxRef, {}, { initialNumItems: 20 })
  const summary = useQuery(getAdminThreadRef, selection ?? 'skip')
  const {
    results: paginatedMessages,
    status: messagesStatus,
    loadMore: loadMoreMessages,
    hasError: messagesHaveError,
    reload: reloadMessages,
  } = useAuditedAdminMessages(selection)
  const sendMessage = useMutation(sendAdminMessageRef)
  const markRead = useMutation(markAdminThreadReadRef)
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const messages = useMemo(() => [...paginatedMessages].reverse(), [paginatedMessages])

  const summarySequenceRef = useRef<{ key: string | null; lastSequence: number | null }>({
    key: selectionKey(selection),
    lastSequence: null,
  })

  useEffect(() => {
    const key = selectionKey(selection)
    const nextSequence = summary?.lastSequence
    const previous = summarySequenceRef.current

    if (previous.key !== key) {
      summarySequenceRef.current = { key, lastSequence: nextSequence ?? null }
      return
    }

    if (nextSequence == null) return
    if (previous.lastSequence == null) {
      summarySequenceRef.current.lastSequence = nextSequence
      return
    }
    if (nextSequence <= previous.lastSequence) return

    summarySequenceRef.current.lastSequence = nextSequence
    reloadMessages()
  }, [reloadMessages, selection, summary?.lastSequence])

  useEffect(() => {
    if (!summary?.threadId || summary.unreadCount === 0 || summary.lastSequence === 0) return
    const threadId = summary.threadId
    const throughSequence = summary.lastSequence
    // Marcar leído es fuego y olvido a propósito: si falla, el contador sigue
    // en rojo y el siguiente render lo reintenta. Lo que cambia es que el fallo
    // deja rastro en vez de irse por un `.catch(() => undefined)`.
    const fiber = runClientFork(
      adminStep(
        'AdminSupport.markThreadRead',
        'support.markAdminThreadRead',
        'support.markAdminThreadRead',
        () => markRead({ threadId, throughSequence })
      ).pipe(
        Effect.catch((failure) =>
          Effect.logError(`[AdminSupportInbox] ${failure.action} falló en ${failure.step}`)
        )
      )
    )
    return () => {
      fiber.interruptUnsafe()
    }
  }, [markRead, summary])

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextBody = body.trim()
    if (!selection || !nextBody || submitting || summary?.canSend !== true) return

    setSubmitting(true)
    setError(null)
    void runClientEffect(
      adminStep('AdminSupport.sendMessage', 'support.sendAdminMessage', t('sendError'), () =>
        sendMessage({ ...selection, body: nextBody })
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setBody('')
            reloadMessages()
          })
        ),
        Effect.catch((failure) =>
          Effect.logError(`[AdminSupportInbox] ${failure.action} falló en ${failure.step}`).pipe(
            Effect.andThen(Effect.sync(() => setError(failure.message)))
          )
        ),
        Effect.ensuring(Effect.sync(() => setSubmitting(false)))
      )
    )
  }

  function roomLabel(item: Pick<InboxItem, 'roomLabel' | 'scopeKind'>) {
    return item.roomLabel ?? (item.scopeKind === 'INTAKE' ? t('temporaryRoom') : t('unknownRoom'))
  }

  return (
    <section className="grid min-h-0 flex-1 gap-5 lg:grid-cols-[minmax(15rem,0.8fr)_minmax(0,2fr)]">
      <Card className="flex min-h-0 flex-col overflow-hidden">
        <CardHeader className="shrink-0">
          <h2 className="font-semibold">{t('inboxTitle')}</h2>
          <p className="text-muted-foreground text-sm">{t('inboxDescription')}</p>
        </CardHeader>
        <CardContent className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {inboxStatus === 'LoadingFirstPage' ? (
            <p className="text-muted-foreground text-sm">{t('loading')}</p>
          ) : inbox.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('emptyInbox')}</p>
          ) : (
            inbox.map((item) => (
              <Link
                key={item.threadId}
                href={`/admin/support?thread=${encodeURIComponent(item.threadId)}`}
                className="hover:bg-muted focus-visible:ring-ring block rounded-md border p-3 transition-colors focus-visible:ring-2 focus-visible:outline-none"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm font-medium">{roomLabel(item)}</span>
                  {item.unreadCount > 0 ? (
                    <span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums">
                      {item.unreadCount}
                    </span>
                  ) : null}
                </div>
                <time
                  className="text-muted-foreground mt-1 block text-xs"
                  dateTime={new Date(item.lastMessageAt).toISOString()}
                >
                  {formatDateTime(item.lastMessageAt, locale)}
                </time>
              </Link>
            ))
          )}
          {inboxStatus === 'CanLoadMore' || inboxStatus === 'LoadingMore' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={inboxStatus === 'LoadingMore'}
              onClick={() => loadMoreInbox(20)}
            >
              {inboxStatus === 'LoadingMore' ? t('loadingMore') : t('loadMoreThreads')}
            </Button>
          ) : null}
        </CardContent>
      </Card>

      <Card
        data-testid="admin-support-conversation"
        className="flex min-h-0 flex-col overflow-hidden"
      >
        <CardHeader className="shrink-0">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-md">
              <MessageSquareText className="size-4" aria-hidden />
            </span>
            <div>
              <h2 className="font-semibold">
                {summary ? roomLabel(summary) : selection ? t('loading') : t('selectThread')}
              </h2>
              {summary ? (
                <p className="text-muted-foreground text-sm">
                  {summary.scopeKind === 'COMPANY' ? t('companyRoom') : t('temporaryRoom')}
                </p>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col space-y-4">
          {!selection ? (
            <p className="text-muted-foreground text-sm">{t('selectThreadDescription')}</p>
          ) : (
            <>
              <div
                className="border-border min-h-64 space-y-3 overflow-y-auto rounded-md border p-3 lg:min-h-0 lg:flex-1"
                aria-live="polite"
                aria-busy={messagesStatus === 'LoadingFirstPage'}
              >
                {messagesStatus === 'LoadingFirstPage' ? (
                  <p className="text-muted-foreground text-sm">{t('loading')}</p>
                ) : messages.length === 0 ? (
                  <p
                    role={messagesHaveError ? 'alert' : undefined}
                    className={
                      messagesHaveError
                        ? 'text-destructive text-sm'
                        : 'text-muted-foreground text-sm'
                    }
                  >
                    {messagesHaveError ? t('sendError') : t('noMessages')}
                  </p>
                ) : (
                  <>
                    {messages.map((message) => (
                      <article
                        key={message.messageId}
                        className={
                          message.authorKind === 'ADMIN'
                            ? 'border-primary/20 ml-auto max-w-[92%] rounded-md border p-3'
                            : 'bg-muted rounded-md p-3'
                        }
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-xs font-semibold">
                            {message.authorKind === 'ADMIN' ? t('author.team') : t('author.client')}
                          </p>
                          <time
                            className="text-muted-foreground text-xs"
                            dateTime={new Date(message.createdAt).toISOString()}
                          >
                            {formatDateTime(message.createdAt, locale)}
                          </time>
                        </div>
                        <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap">
                          {message.body}
                        </p>
                      </article>
                    ))}
                    {messagesHaveError ? (
                      <p role="alert" className="text-destructive text-sm">
                        {t('sendError')}
                      </p>
                    ) : null}
                  </>
                )}
              </div>

              {messagesStatus === 'CanLoadMore' || messagesStatus === 'LoadingMore' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="shrink-0"
                  disabled={messagesStatus === 'LoadingMore'}
                  onClick={() => loadMoreMessages(30)}
                >
                  {messagesStatus === 'LoadingMore' ? t('loadingMore') : t('loadMoreMessages')}
                </Button>
              ) : null}

              {summary?.canSend === false ? (
                <p className="text-muted-foreground shrink-0 text-sm">{t('cannotReply')}</p>
              ) : summary?.canSend === true ? (
                <form className="shrink-0 space-y-3" onSubmit={handleSubmit}>
                  <div className="space-y-2">
                    <label htmlFor="admin-support-message" className="text-sm font-medium">
                      {t('replyLabel')}
                    </label>
                    <Textarea
                      id="admin-support-message"
                      value={body}
                      maxLength={MESSAGE_MAX_LENGTH}
                      rows={4}
                      placeholder={t('replyPlaceholder')}
                      disabled={submitting}
                      onChange={(event) => setBody(event.target.value)}
                    />
                    <p className="text-muted-foreground text-right text-xs tabular-nums">
                      {t('characterCount', { count: body.length, max: MESSAGE_MAX_LENGTH })}
                    </p>
                  </div>
                  {error ? (
                    <p role="alert" className="text-destructive text-sm">
                      {error}
                    </p>
                  ) : null}
                  <Button type="submit" disabled={submitting || body.trim().length === 0}>
                    <Send className="mr-2 size-4" aria-hidden />
                    {submitting ? t('sending') : t('send')}
                  </Button>
                </form>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
    </section>
  )
}
