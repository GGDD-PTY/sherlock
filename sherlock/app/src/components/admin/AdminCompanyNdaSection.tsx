'use client'

// El NDA de invitados no tiene texto de fábrica. El equipo pega el que ya
// aprobó y confirma; la mutation `configureCompanyNda` valida, reemplaza la
// plantilla activa en español y deja el audit log. El bearer y el step-up
// siguen siendo los de esa mutation: acá no se duplican.

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useTranslations } from 'next-intl'
import { Effect } from 'effect'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { adminStep, type AdminActionError } from '@/components/admin/adminAction'
import {
  useAdminVdrCapability,
  useAdminVdrOperator,
} from '@/components/company/vdr/AdminVdrCapabilityContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { runClientEffect } from '@/lib/effect/client-runtime'

export function AdminCompanyNdaSection({ companyId }: { companyId: Id<'companies'> }) {
  const t = useTranslations('adminCompanyNda')
  const roster = useQuery(api.guestAccess.listForCompany, { companyId, locale: 'es' })
  const configure = useMutation(api.guestAccess.configureCompanyNda)
  const authorize = useAdminVdrCapability()
  const operator = useAdminVdrOperator()
  const [title, setTitle] = useState('')
  const [version, setVersion] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<'saved' | 'error' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const trimmedTitle = title.trim()
  const trimmedVersion = version.trim()
  const canSubmit =
    !busy &&
    trimmedTitle.length > 0 &&
    trimmedTitle.length <= 200 &&
    trimmedVersion.length > 0 &&
    trimmedVersion.length <= 100 &&
    content.trim().length > 0 &&
    content.length <= 12000

  function confirm(event: FormEvent) {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setNotice(null)
    setFailure(null)
    const input = {
      companyId,
      title: trimmedTitle,
      content,
      version: trimmedVersion,
      locale: 'es' as const,
    }
    void runClientEffect(
      adminStep(
        'AdminCompanyNda.confirm',
        'guestAccess.configureCompanyNda',
        t('error'),
        async () => configure(await authorize('GUEST_INVITE', `COMPANY_NDA:${companyId}`, input))
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            setTitle('')
            setVersion('')
            setContent('')
            setNotice('saved')
          })
        ),
        Effect.catch((error: AdminActionError) =>
          Effect.logError(`[AdminCompanyNda] ${error.action} falló en ${error.step}`).pipe(
            Effect.andThen(
              Effect.sync(() => {
                setFailure(error.message)
                setNotice('error')
              })
            )
          )
        ),
        Effect.ensuring(Effect.sync(() => setBusy(false)))
      )
    )
  }

  if (roster === undefined) {
    return (
      <section
        data-testid="admin-company-nda"
        data-admin-operator={String(operator)}
        aria-busy="true"
        aria-label={t('loading')}
      >
        <p className="text-muted-foreground text-sm">{t('loading')}</p>
      </section>
    )
  }

  return (
    <section
      data-testid="admin-company-nda"
      data-admin-operator={String(operator)}
      className="border-border space-y-4 border-t pt-6"
      aria-labelledby="admin-company-nda-heading"
    >
      <div className="space-y-1">
        <h2 id="admin-company-nda-heading" className="text-lg font-semibold">
          {t('title')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {roster.ndaConfigured ? t('present') : t('missing')}
        </p>
      </div>
      <form onSubmit={confirm} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="admin-company-nda-title">{t('titleLabel')}</Label>
            <Input
              id="admin-company-nda-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('titlePlaceholder')}
              maxLength={200}
              disabled={busy}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="admin-company-nda-version">{t('versionLabel')}</Label>
            <Input
              id="admin-company-nda-version"
              value={version}
              onChange={(event) => setVersion(event.target.value)}
              placeholder={t('versionPlaceholder')}
              maxLength={100}
              disabled={busy}
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="admin-company-nda-content">{t('contentLabel')}</Label>
          <Textarea
            id="admin-company-nda-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t('contentPlaceholder')}
            maxLength={12000}
            disabled={busy}
            required
            className="min-h-40"
          />
        </div>
        <Button type="submit" className="min-h-11" disabled={!canSubmit}>
          {busy ? t('working') : t('confirm')}
        </Button>
      </form>
      {notice === 'saved' ? (
        <p role="status" className="text-sm">
          {t('saved')}
        </p>
      ) : null}
      {notice === 'error' ? (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      ) : null}
    </section>
  )
}
