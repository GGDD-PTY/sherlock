'use client'

import { useState } from 'react'
import { Effect } from 'effect'
import { Link2, Loader2, PauseCircle, PlayCircle, RefreshCw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useMutation, useQuery } from 'convex/react'

import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { runClientEffect } from '@/lib/effect/client-runtime'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'

type BindingStatus = 'LEGACY' | 'BOUND' | 'UNRESOLVED' | 'AMBIGUOUS' | 'INVALID_BINDING'
type RolloutPhase = 'UNENFORCED' | 'PREPARING' | 'ENFORCED'
type BusyAction = 'backfill' | 'resolve' | 'activate' | 'pause'
type Confirmation = 'activate' | 'pause'
type Notice = { kind: 'success' | 'error'; message: string }

const PAGE_SIZE = 25
const MIN_REASON_LENGTH = 10
const MAX_REASON_LENGTH = 500

const STATUS_VARIANTS: Record<BindingStatus, 'default' | 'secondary' | 'destructive' | 'outline'> =
  {
    LEGACY: 'secondary',
    BOUND: 'default',
    UNRESOLVED: 'outline',
    AMBIGUOUS: 'secondary',
    INVALID_BINDING: 'destructive',
  }

/**
 * Administra el inventario y el cutover empresa-organización. WorkOS no recibe
 * escrituras desde esta pantalla. Las mutaciones cambian solamente el estado
 * de autorización que Sherlock guarda en Convex.
 */
export function CompanyAuthorizationRolloutClient() {
  const t = useTranslations('admin.workos.bindingRollout')
  const [pageCursors, setPageCursors] = useState<Array<string | undefined>>([undefined])
  const [selectedCompanyId, setSelectedCompanyId] = useState<Id<'companies'> | null>(null)
  const [providerOrgId, setProviderOrgId] = useState('')
  const [resolutionReason, setResolutionReason] = useState('')
  const [pauseReason, setPauseReason] = useState('')
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  const pageCursor = pageCursors.at(-1)
  const inventory = useQuery(
    api.companyAuthorizationRollout.getCompanyOrganizationBindingInventory,
    {
      ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
      numItems: PAGE_SIZE,
    }
  )
  const candidates = useQuery(
    api.companyAuthorizationRollout.getCompanyOrganizationBindingCandidates,
    selectedCompanyId === null ? 'skip' : { companyId: selectedCompanyId }
  )

  const backfillBindings = useMutation(
    api.companyAuthorizationRollout.backfillCompanyOrganizationBindings
  )
  const resolveBinding = useMutation(
    api.companyAuthorizationRollout.resolveCompanyOrganizationBinding
  )
  const activateCutover = useMutation(
    api.companyAuthorizationRollout.activateCompanyOrganizationBindingCutover
  )
  const pauseCutover = useMutation(
    api.companyAuthorizationRollout.pauseCompanyOrganizationBindingCutover
  )

  const isBusy = busyAction !== null
  const phase: RolloutPhase = inventory?.enforcementStatus ?? 'UNENFORCED'
  const candidateOptions = candidates?.candidateProviderOrgIds ?? []
  const canResolve =
    selectedCompanyId !== null &&
    candidateOptions.includes(providerOrgId) &&
    resolutionReason.trim().length >= MIN_REASON_LENGTH &&
    resolutionReason.trim().length <= MAX_REASON_LENGTH &&
    !isBusy
  const canPause =
    phase !== 'UNENFORCED' &&
    pauseReason.trim().length >= MIN_REASON_LENGTH &&
    pauseReason.trim().length <= MAX_REASON_LENGTH &&
    !isBusy

  function runAction<A>({
    action,
    busy,
    step,
    errorMessage,
    run,
    onSuccess,
  }: {
    action: string
    busy: BusyAction
    step: string
    errorMessage: string
    run: () => Promise<A>
    onSuccess: (result: A) => void
  }) {
    if (busyAction !== null) return
    setBusyAction(busy)
    setNotice(null)

    void runClientEffect(
      adminStep(action, step, errorMessage, run).pipe(
        Effect.tap((result) => Effect.sync(() => onSuccess(result))),
        Effect.catchTag('AdminActionError', (failure: AdminActionError) =>
          Effect.logError(
            `[CompanyAuthorizationRolloutClient] ${failure.action} falló en ${failure.step}`
          ).pipe(
            Effect.andThen(Effect.sync(() => setNotice({ kind: 'error', message: errorMessage })))
          )
        ),
        Effect.ensuring(Effect.sync(() => setBusyAction(null)))
      )
    )
  }

  function handleBackfill() {
    const durableCursor = inventory?.inventoryNextCursor
    const args = {
      ...(durableCursor === undefined ? {} : { cursor: durableCursor }),
      numItems: PAGE_SIZE,
    }
    runAction({
      action: 'CompanyAuthorizationRollout.backfill',
      busy: 'backfill',
      step: 'companyAuthorizationRollout.backfillCompanyOrganizationBindings',
      errorMessage: t('backfill.error'),
      run: () => backfillBindings(args),
      onSuccess: (result) => {
        setPageCursors([undefined])
        setNotice({
          kind: 'success',
          message: result.isDone
            ? t('backfill.completed', {
                unresolved: result.unresolved + result.ambiguous,
              })
            : t('backfill.pageCompleted', {
                unresolved: result.unresolved + result.ambiguous,
              }),
        })
      },
    })
  }

  function handleResolve() {
    if (selectedCompanyId === null || !canResolve) return
    runAction({
      action: 'CompanyAuthorizationRollout.resolve',
      busy: 'resolve',
      step: 'companyAuthorizationRollout.resolveCompanyOrganizationBinding',
      errorMessage: t('resolution.error'),
      run: () =>
        resolveBinding({
          companyId: selectedCompanyId,
          providerOrgId: providerOrgId.trim(),
          reason: resolutionReason.trim(),
        }),
      onSuccess: (result) => {
        setSelectedCompanyId(null)
        setProviderOrgId('')
        setResolutionReason('')
        setNotice({
          kind: 'success',
          message:
            result.status === 'BOUND' ? t('resolution.success') : t('resolution.savedPending'),
        })
      },
    })
  }

  function handleActivate() {
    runAction({
      action: 'CompanyAuthorizationRollout.activate',
      busy: 'activate',
      step: 'companyAuthorizationRollout.activateCompanyOrganizationBindingCutover',
      errorMessage: t('activate.error'),
      run: () => activateCutover({}),
      onSuccess: () => {
        setConfirmation(null)
        setNotice({ kind: 'success', message: t('activate.success') })
      },
    })
  }

  function handlePause() {
    if (!canPause) return
    runAction({
      action: 'CompanyAuthorizationRollout.pause',
      busy: 'pause',
      step: 'companyAuthorizationRollout.pauseCompanyOrganizationBindingCutover',
      errorMessage: t('pause.error'),
      run: () => pauseCutover({ reason: pauseReason.trim() }),
      onSuccess: () => {
        setConfirmation(null)
        setPauseReason('')
        setPageCursors([undefined])
        setNotice({ kind: 'success', message: t('pause.success') })
      },
    })
  }

  function selectCompany(companyId: Id<'companies'>) {
    setSelectedCompanyId(companyId)
    setProviderOrgId('')
    setResolutionReason('')
    setNotice(null)
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-xl">
                <Link2 className="text-primary h-5 w-5" />
                {t('title')}
              </CardTitle>
              <CardDescription>{t('description')}</CardDescription>
            </div>
            <Badge variant={phase === 'ENFORCED' ? 'default' : 'outline'}>
              {t(`phase.${phase}`)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-6">
          {notice ? (
            <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} aria-live="polite">
              <AlertTitle>
                {notice.kind === 'error' ? t('notice.errorTitle') : t('notice.successTitle')}
              </AlertTitle>
              <AlertDescription>{notice.message}</AlertDescription>
            </Alert>
          ) : null}

          {inventory?.inventoryComplete && inventory.pageHasDrift ? (
            <Alert>
              <AlertTitle>{t('inventory.driftTitle')}</AlertTitle>
              <AlertDescription>{t('inventory.driftDescription')}</AlertDescription>
            </Alert>
          ) : null}

          <section className="space-y-3" aria-labelledby="binding-rollout-actions">
            <div className="space-y-1">
              <h3 id="binding-rollout-actions" className="font-medium">
                {t('controls.title')}
              </h3>
              <p className="text-muted-foreground text-sm">{t('controls.description')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {phase !== 'ENFORCED' && !inventory?.inventoryComplete ? (
                <Button onClick={handleBackfill} disabled={isBusy || inventory === undefined}>
                  {busyAction === 'backfill' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : inventory?.inventoryNextCursor ? (
                    <RefreshCw className="h-4 w-4" />
                  ) : (
                    <PlayCircle className="h-4 w-4" />
                  )}
                  {inventory?.inventoryNextCursor ? t('backfill.continue') : t('backfill.start')}
                </Button>
              ) : null}
              <Button
                variant="outline"
                disabled={
                  isBusy ||
                  !inventory?.inventoryComplete ||
                  phase === 'ENFORCED' ||
                  Boolean(inventory?.pageHasDrift)
                }
                onClick={() => setConfirmation('activate')}
              >
                <PlayCircle className="h-4 w-4" />
                {t('activate.action')}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t('activate.blockedHint')}</p>
          </section>

          <section
            className="border-border space-y-3 border-t pt-5"
            aria-labelledby="inventory-title"
          >
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div className="space-y-1">
                <h3 id="inventory-title" className="font-medium">
                  {t('inventory.title')}
                </h3>
                <p className="text-muted-foreground text-sm">{t('inventory.description')}</p>
              </div>
              {inventory ? (
                <p className="text-muted-foreground text-xs tabular-nums">
                  {t('inventory.pageSummary', {
                    workosOwned: inventory.summary.workosOwned,
                    bound: inventory.summary.bound,
                    pending:
                      inventory.summary.unresolved +
                      inventory.summary.ambiguous +
                      inventory.summary.invalid,
                  })}
                </p>
              ) : null}
            </div>

            {inventory === undefined ? (
              <div
                className="text-muted-foreground flex items-center gap-2 py-8 text-sm"
                aria-busy="true"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('inventory.loading')}
              </div>
            ) : inventory.rows.length === 0 ? (
              <p className="text-muted-foreground py-8 text-sm">{t('inventory.empty')}</p>
            ) : (
              <Table aria-label={t('inventory.tableLabel')}>
                <TableHeader>
                  <TableRow>
                    <TableHead allowWrap>{t('inventory.company')}</TableHead>
                    <TableHead>{t('inventory.status')}</TableHead>
                    <TableHead className="text-right">{t('inventory.candidates')}</TableHead>
                    <TableHead className="text-right">{t('inventory.bindings')}</TableHead>
                    <TableHead className="text-right">{t('inventory.action')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {inventory.rows.map((row) => (
                    <TableRow key={row.companyId}>
                      <TableCell allowWrap>
                        <p className="font-medium">{row.companyName}</p>
                        <p className="font-figure text-muted-foreground text-xs break-all">
                          {row.companyId}
                        </p>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANTS[row.status]}>
                          {t(`status.${row.status}`)}
                        </Badge>
                        {row.createdAfterInventoryStart ? (
                          <p className="text-warning mt-1 text-xs">
                            {t('inventory.createdAfterStart')}
                          </p>
                        ) : row.inventoryDrift ? (
                          <p className="text-warning mt-1 text-xs">
                            {t('inventory.changedAfterReview')}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-figure text-right tabular-nums">
                        {row.candidateCount}
                      </TableCell>
                      <TableCell className="font-figure text-right tabular-nums">
                        {row.bindingCount}
                      </TableCell>
                      <TableCell className="text-right">
                        {!row.workosOwned ? (
                          <span className="text-muted-foreground text-xs">
                            {t('inventory.notApplicable')}
                          </span>
                        ) : row.status === 'BOUND' ? (
                          <span className="text-muted-foreground text-xs">
                            {t('inventory.ready')}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={isBusy}
                            onClick={() => selectCompany(row.companyId)}
                          >
                            {t('inventory.resolve')}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <div className="flex items-center justify-between gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pageCursors.length === 1 || isBusy}
                onClick={() => setPageCursors((current) => current.slice(0, -1))}
              >
                {t('inventory.previous')}
              </Button>
              <span className="text-muted-foreground text-xs tabular-nums">
                {t('inventory.page', { page: pageCursors.length })}
              </span>
              <Button
                size="sm"
                variant="outline"
                disabled={inventory === undefined || inventory.isDone || isBusy}
                onClick={() => {
                  if (inventory && !inventory.isDone) {
                    setPageCursors((current) => [...current, inventory.continueCursor])
                  }
                }}
              >
                {t('inventory.next')}
              </Button>
            </div>
          </section>

          {selectedCompanyId !== null ? (
            <section
              className="border-border space-y-4 border-t pt-5"
              aria-labelledby="resolution-title"
            >
              <div className="space-y-1">
                <h3 id="resolution-title" className="font-medium">
                  {t('resolution.title')}
                </h3>
                <p className="text-muted-foreground text-sm">
                  {t('resolution.description', { companyId: selectedCompanyId })}
                </p>
              </div>

              {candidates === undefined ? (
                <div
                  className="text-muted-foreground flex items-center gap-2 text-sm"
                  aria-busy="true"
                >
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('resolution.loading')}
                </div>
              ) : (
                <div className="grid gap-4 lg:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="binding-provider-org">{t('resolution.organization')}</Label>
                    {candidateOptions.length > 0 ? (
                      <Select value={providerOrgId} onValueChange={setProviderOrgId}>
                        <SelectTrigger id="binding-provider-org">
                          <SelectValue placeholder={t('resolution.selectOrganization')} />
                        </SelectTrigger>
                        <SelectContent>
                          {candidateOptions.map((candidate) => (
                            <SelectItem key={candidate} value={candidate}>
                              {candidate}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <p
                        id="binding-provider-org"
                        className="border-border text-muted-foreground rounded-md border p-3 text-sm"
                      >
                        {t('resolution.noCandidates')}
                      </p>
                    )}
                    <p className="text-muted-foreground text-xs">
                      {candidateOptions.length > 0
                        ? t('resolution.candidateHint')
                        : t('resolution.reconcileHint')}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="binding-resolution-reason">{t('resolution.reason')}</Label>
                    <Textarea
                      id="binding-resolution-reason"
                      value={resolutionReason}
                      onChange={(event) => setResolutionReason(event.target.value)}
                      minLength={MIN_REASON_LENGTH}
                      maxLength={MAX_REASON_LENGTH}
                      placeholder={t('resolution.reasonPlaceholder')}
                    />
                    <p className="text-muted-foreground text-xs">
                      {t('reasonLength', { min: MIN_REASON_LENGTH, max: MAX_REASON_LENGTH })}
                    </p>
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button onClick={handleResolve} disabled={!canResolve}>
                  {busyAction === 'resolve' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t('resolution.action')}
                </Button>
                <Button
                  variant="outline"
                  disabled={isBusy}
                  onClick={() => {
                    setSelectedCompanyId(null)
                    setProviderOrgId('')
                    setResolutionReason('')
                  }}
                >
                  {t('cancel')}
                </Button>
              </div>
            </section>
          ) : null}

          <section className="border-border space-y-3 border-t pt-5" aria-labelledby="pause-title">
            <div className="space-y-1">
              <h3 id="pause-title" className="font-medium">
                {t('pause.title')}
              </h3>
              <p className="text-muted-foreground text-sm">{t('pause.description')}</p>
            </div>
            <div className="max-w-2xl space-y-2">
              <Label htmlFor="binding-pause-reason">{t('pause.reason')}</Label>
              <Textarea
                id="binding-pause-reason"
                value={pauseReason}
                onChange={(event) => setPauseReason(event.target.value)}
                minLength={MIN_REASON_LENGTH}
                maxLength={MAX_REASON_LENGTH}
                placeholder={t('pause.reasonPlaceholder')}
                disabled={phase === 'UNENFORCED' || isBusy}
              />
              <p className="text-muted-foreground text-xs">
                {t('reasonLength', { min: MIN_REASON_LENGTH, max: MAX_REASON_LENGTH })}
              </p>
            </div>
            <Button variant="outline" disabled={!canPause} onClick={() => setConfirmation('pause')}>
              <PauseCircle className="h-4 w-4" />
              {t('pause.action')}
            </Button>
          </section>
        </CardContent>
      </Card>

      <AlertDialog
        open={confirmation === 'activate'}
        onOpenChange={(open) => {
          if (!open && busyAction !== 'activate') setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('activate.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('activate.confirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === 'activate'}>
              {t('cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={busyAction === 'activate'}
              onClick={(event) => {
                event.preventDefault()
                handleActivate()
              }}
            >
              {busyAction === 'activate' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('activate.confirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirmation === 'pause'}
        onOpenChange={(open) => {
          if (!open && busyAction !== 'pause') setConfirmation(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pause.confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('pause.confirmDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAction === 'pause'}>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyAction === 'pause'}
              onClick={(event) => {
                event.preventDefault()
                handlePause()
              }}
            >
              {busyAction === 'pause' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('pause.confirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
