'use client'

import { useEffect, useState, type FormEvent } from 'react'
import { useMutation, useQuery } from 'convex/react'
import { useTranslations } from 'next-intl'
import { Effect, Schema } from 'effect'
import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import { useAdminVdrCapability } from '@/components/company/vdr/AdminVdrCapabilityContext'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { runClientEffect } from '@/lib/effect/client-runtime'
import { formatShortDate } from '@/lib/utils'

// ===== LA COSTURA CON EFFECT =====
// Invitar y revocar son la misma forma: se pide la capacidad al admin, se muta
// y la UI solo necesita saber si se pudo. El `try/catch/finally` de cada
// handler se vuelve un programa con nombre, y el error deja de ser un `catch`
// vacío que se traga cualquier cosa: `Cause` conserva el fallo completo.
class GuestActionFailed extends Schema.TaggedError<GuestActionFailed>()('GuestActionFailed', {
  cause: Schema.Defect(),
}) {}

const runGuestAction = Effect.fn('CompanyGuests.action')(
  function* (action: () => Promise<unknown>): Effect.fn.Return<boolean, GuestActionFailed> {
    yield* Effect.tryPromise({
      try: action,
      catch: (cause) => new GuestActionFailed({ cause }),
    })
    return true
  },
  Effect.orElseSucceed(() => false)
)

export function CompanyGuestPanel({
  companyId,
  documents,
  locale,
  onAvailabilityChange,
}: {
  companyId: Id<'companies'>
  documents: { _id: Id<'documents'>; name: string }[]
  locale: 'es'
  onAvailabilityChange?: (available: boolean) => void
}) {
  const t = useTranslations('vdrGuest')
  const roster = useQuery(api.guestAccess.listForCompany, { companyId, locale })
  const invite = useMutation(api.guestAccess.inviteToCompany)
  const revoke = useMutation(api.guestAccess.revoke)
  const authorize = useAdminVdrCapability()
  const [email, setEmail] = useState('')
  const [days, setDays] = useState(7)
  const [selected, setSelected] = useState<Id<'documents'>[]>([])
  const [revoking, setRevoking] = useState<Id<'guestInvitations'> | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'invited' | 'revoked' | 'error' | null>(null)
  async function send(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setStatus(null)
    const invited = await runClientEffect(
      runGuestAction(async () => {
        const input = {
          companyId,
          documentIds: selected,
          email: email.trim(),
          expiresInDays: days,
          locale,
        }
        return invite(await authorize('GUEST_INVITE', `COMPANY:${companyId}`, input))
      })
    )
    setBusy(false)
    if (!invited) {
      setStatus('error')
      return
    }
    setEmail('')
    setSelected([])
    setStatus('invited')
  }
  async function revokeAccess(event: FormEvent) {
    event.preventDefault()
    if (!revoking || busy) return
    setBusy(true)
    setStatus(null)
    const revoked = await runClientEffect(
      runGuestAction(async () =>
        revoke(
          await authorize('GUEST_REVOKE', `GUEST_INVITATION:${revoking}`, {
            invitationId: revoking,
            reason: reason.trim(),
          })
        )
      )
    )
    setBusy(false)
    if (!revoked) {
      setStatus('error')
      return
    }
    setRevoking(null)
    setReason('')
    setStatus('revoked')
  }
  // Sin NDA aprobado para la empresa no hay nada que el cliente pueda hacer
  // aquí: la sección no se pinta y el nav tampoco la ofrece.
  const available = roster?.ndaConfigured === true
  useEffect(() => {
    if (roster) onAvailabilityChange?.(available)
  }, [available, onAvailabilityChange, roster])
  if (!roster) return <p role="status">{t('panel.loading')}</p>
  if (!available) return null
  return (
    <section
      className="border-border space-y-4 border-t pt-6"
      aria-labelledby="company-guests-heading"
    >
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="company-guests-heading">{t('panel.title')}</h2>
        <p className="text-muted-foreground text-sm">{t('panel.description')}</p>
      </div>
      {!roster.capabilities.canInvite && (
        <p role="status" className="text-sm">
          {t('panel.deliveryMissing')}
        </p>
      )}
      {documents.length === 0 && (
        <p role="status" className="text-sm">
          {t('panel.empty')}
        </p>
      )}
      {roster.ndaConfigured && roster.capabilities.canInvite && documents.length > 0 && (
        <form onSubmit={(...args) => void send(...args)} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="company-guest-email">{t('panel.email')}</Label>
              <Input
                id="company-guest-email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                disabled={busy}
                maxLength={254}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="company-guest-days">{t('panel.expires')}</Label>
              <Input
                id="company-guest-days"
                type="number"
                min={1}
                max={30}
                required
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
                disabled={busy}
              />
            </div>
          </div>
          <fieldset disabled={busy} className="space-y-2">
            <legend className="mb-2 text-sm font-medium">{t('panel.documents')}</legend>
            {documents.length ? (
              <div className="max-h-64 overflow-y-auto">
                {documents.map((document) => (
                  <label
                    key={document._id}
                    className="flex min-h-11 items-center gap-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="accent-primary h-4 w-4"
                      checked={selected.includes(document._id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, document._id]
                            : current.filter((id) => id !== document._id)
                        )
                      }
                    />
                    <span className="min-w-0 break-words">{document.name}</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{t('panel.empty')}</p>
            )}
          </fieldset>
          <Button
            type="submit"
            disabled={
              busy ||
              !roster.ndaConfigured ||
              !roster.capabilities.canInvite ||
              !email.trim() ||
              !Number.isInteger(days) ||
              days < 1 ||
              days > 30 ||
              !selected.length ||
              selected.length > 50
            }
            className="min-h-11"
          >
            {busy ? t('panel.working') : t('panel.invite')}
          </Button>
        </form>
      )}
      <p role={status === 'error' ? 'alert' : 'status'} className="text-sm" aria-live="polite">
        {status ? t(`panel.${status}`) : ''}
      </p>
      {roster.invitations.length ? (
        <ul className="divide-border divide-y">
          {roster.invitations.map((invitation) => (
            <li key={invitation.invitationId} className="space-y-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{invitation.maskedEmail}</p>
                  <p className="text-muted-foreground text-sm">
                    {t(`panel.status.${invitation.status}`)} ·{' '}
                    {t('panel.documentCount', { count: invitation.documentCount })}
                  </p>
                  <p className="text-muted-foreground text-sm">
                    {t('panel.expiry', {
                      date: formatShortDate(invitation.expiresAt, locale),
                    })}
                  </p>
                </div>
                {!['REVOKED', 'EXPIRED'].includes(invitation.status) && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setRevoking(invitation.invitationId)
                      setReason('')
                    }}
                  >
                    {t('panel.revoke')}
                  </Button>
                )}
              </div>
              {revoking === invitation.invitationId && (
                <form onSubmit={(...args) => void revokeAccess(...args)} className="space-y-3">
                  <Label htmlFor="guest-revoke-reason">{t('panel.revokeReason')}</Label>
                  <Input
                    id="guest-revoke-reason"
                    required
                    minLength={5}
                    maxLength={500}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    disabled={busy}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="submit"
                      variant="destructive"
                      disabled={busy || reason.trim().length < 5}
                    >
                      {t('panel.confirmRevoke')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setRevoking(null)}
                    >
                      {t('panel.cancel')}
                    </Button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {roster.hasMore && <p className="text-muted-foreground text-sm">{t('panel.more')}</p>}
    </section>
  )
}
