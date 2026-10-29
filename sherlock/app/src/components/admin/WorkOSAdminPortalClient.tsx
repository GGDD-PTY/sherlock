'use client'

// ============================================================================
// PORTAL DE ADMIN DE WORKOS
// ============================================================================
// ===== LA RESPUESTA DE LA RED SE DECODIFICA, NO SE CASTEA =====
// `(await response.json()) as PortalResponse` daba por buena cualquier cosa que
// devolviera `/api/workos/admin-portal`. El único uso de ese dato es abrir una
// pestaña con `data.link`: un `link` que no fuera una URL absoluta de WorkOS —
// una respuesta vieja, un proxy que devuelve HTML, un error con otra forma— se
// habría pasado tal cual a `window.open`. Ahora el cuerpo se decodifica y el
// enlace tiene que ser `https://`; lo que no encaja es un fallo con nombre.
// ============================================================================

import { useState } from 'react'
import { Effect, Schema } from 'effect'
import { ExternalLink, GlobeLock, KeyRound, Loader2, ShieldCheck, UserCog } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

import { adminStep, AdminActionError } from '@/components/admin/adminAction'
import { CompanyAuthorizationRolloutClient } from '@/components/admin/CompanyAuthorizationRolloutClient'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { runClientEffect } from '@/lib/effect/client-runtime'
import { cn } from '@/lib/utils'

type WorkOSEnvStatus = {
  apiKey: boolean
  clientId: boolean
  cookiePassword: boolean
  webhookSecret: boolean
  redirectUri: boolean
}

type PortalIntent = 'sso' | 'domain_verification'

// Lo único que esta pantalla hace con la respuesta es abrir el enlace, así que
// el enlace es lo único que el schema exige, y exige que sea https.
const PortalResponseSchema = Schema.Struct({
  link: Schema.String.pipe(Schema.check(Schema.isStartsWith('https://'))),
})

const decodePortalResponse = Schema.decodeUnknownOption(PortalResponseSchema)

type WorkOSAdminPortalClientProps = {
  envStatus: WorkOSEnvStatus
}

/** El fallo de abrir el portal, con el paso que lo produjo. */
class PortalError extends Schema.TaggedError<PortalError>()('PortalError', {
  step: Schema.Literals(['request', 'decode']),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const requestPortalLink = Effect.fn('WorkOSAdminPortal.openPortal')(function* (
  organizationId: string,
  intent: PortalIntent
): Effect.fn.Return<string, PortalError> {
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch('/api/workos/admin-portal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ organizationId, intent }),
      }),
    catch: (cause) => new PortalError({ step: 'request', cause }),
  })

  // Un 4xx/5xx trae cuerpo de error, no un enlace: para esta pantalla es lo
  // mismo que un cuerpo que no decodifica.
  if (!response.ok) return yield* Effect.fail(new PortalError({ step: 'decode' }))

  const body = yield* Effect.tryPromise({
    try: (): Promise<unknown> => response.json(),
    catch: (cause) => new PortalError({ step: 'decode', cause }),
  })

  const decoded = decodePortalResponse(body)
  if (decoded._tag === 'None') return yield* Effect.fail(new PortalError({ step: 'decode' }))
  return decoded.value.link
})

// ===== EL AVISO DICE QUÉ FALLÓ Y CON QUÉ CÓDIGO BUSCARLO =====
// `/api/admin/make-admin` responde el envelope `{ error, requestId }` de
// `apiError`. Sin esto, «email inválido», «se cayó la sesión admin» y «error
// interno» salen con la misma frase, y quien reporta el fallo no tiene el
// código con el que se encuentra la línea del log del servidor. Llegó con la
// pantalla `/admin/users` que D2 retiró.
const ApiErrorEnvelopeSchema = Schema.Struct({
  error: Schema.optional(Schema.String),
  requestId: Schema.optional(Schema.String),
})
const decodeApiErrorEnvelope = Schema.decodeUnknownOption(ApiErrorEnvelopeSchema)

/**
 * Mensaje del aviso para una respuesta 4xx/5xx de la ruta admin. `fallback` es
 * lo que se dice cuando el cuerpo no trae `error` —o ni siquiera es JSON—, y
 * `supportCode` formatea el `requestId` con el copy de la pantalla.
 */
function makeAdminErrorMessage(
  body: unknown,
  fallback: string,
  supportCode: (requestId: string) => string
): string {
  const decoded = decodeApiErrorEnvelope(body)
  const envelope = decoded._tag === 'Some' ? decoded.value : undefined
  const detail = envelope?.error?.trim()
  const requestId = envelope?.requestId?.trim()
  const message = detail !== undefined && detail !== '' ? detail : fallback
  if (!requestId) return message

  return `${message}${/[.!?]$/.test(message) ? '' : '.'} ${supportCode(requestId)}`
}

const ENV_ITEMS: Array<{ key: keyof WorkOSEnvStatus; label: string }> = [
  { key: 'apiKey', label: 'WORKOS_API_KEY' },
  { key: 'clientId', label: 'WORKOS_CLIENT_ID' },
  { key: 'cookiePassword', label: 'WORKOS_COOKIE_PASSWORD' },
  { key: 'webhookSecret', label: 'WORKOS_WEBHOOK_SECRET' },
  { key: 'redirectUri', label: 'NEXT_PUBLIC_WORKOS_REDIRECT_URI' },
]

export function WorkOSAdminPortalClient({ envStatus }: WorkOSAdminPortalClientProps) {
  const t = useTranslations('admin.workos')
  const [organizationId, setOrganizationId] = useState('')
  const [loadingIntent, setLoadingIntent] = useState<PortalIntent | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [adminEmail, setAdminEmail] = useState('')
  const [isMakingAdmin, setIsMakingAdmin] = useState(false)

  const isWorkOSConfigured = Object.values(envStatus).every(Boolean)
  const canSubmit = isWorkOSConfigured && organizationId.trim().length > 0 && !loadingIntent

  function openPortal(intent: PortalIntent) {
    const trimmedOrganizationId = organizationId.trim()
    if (!trimmedOrganizationId) return

    setLoadingIntent(intent)
    setMessage(null)

    // El programa se corre en el borde. Los dos pasos ya no comparten aviso:
    // «no se pudo contactar» es el transporte, «no se pudo generar» es un
    // cuerpo que no trae un enlace utilizable.
    void runClientEffect(
      requestPortalLink(trimmedOrganizationId, intent).pipe(
        Effect.tap((link) =>
          Effect.sync(() => {
            window.open(link, '_blank', 'noopener,noreferrer')
            setMessage({ type: 'success', text: t('success') })
          })
        ),
        Effect.catchTag('PortalError', (error) =>
          Effect.sync(() => {
            setMessage({
              type: 'error',
              text: error.step === 'request' ? t('errors.contact') : t('errors.generate'),
            })
          })
        ),
        Effect.ensuring(Effect.sync(() => setLoadingIntent(null)))
      )
    )
  }

  // ===== HACER ADMIN =====
  // Llegó de `/admin/users` con D2. `makeAdmin` no está expuesta como mutation
  // con auth, así que la llamada va por la API route, que es la que escribe el
  // `createAuditLog`. Un 4xx/5xx es un fallo con nombre igual que una excepción
  // de red.
  function makeAdmin() {
    const email = adminEmail.trim()
    if (!email || isMakingAdmin) return
    if (!window.confirm(t('makeAdmin.confirm', { email }))) return

    setIsMakingAdmin(true)
    void runClientEffect(
      adminStep('WorkOSAdminPortal.makeAdmin', 'api.admin.make-admin', t('makeAdmin.error'), () =>
        fetch('/api/admin/make-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        })
      ).pipe(
        Effect.flatMap((response) =>
          response.ok
            ? Effect.void
            : Effect.flatMap(
                // El cuerpo puede no ser JSON (un 502 del borde, por ejemplo);
                // en ese caso el aviso se queda con el status.
                Effect.promise((): Promise<unknown> => response.json().catch(() => null)),
                (body) =>
                  Effect.fail(
                    new AdminActionError({
                      action: 'WorkOSAdminPortal.makeAdmin',
                      step: 'api.admin.make-admin',
                      message: makeAdminErrorMessage(
                        body,
                        t('makeAdmin.httpError', { status: response.status }),
                        (requestId) => t('makeAdmin.supportCode', { requestId })
                      ),
                    })
                  )
              )
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            toast.success(t('makeAdmin.success', { email }))
            setAdminEmail('')
          })
        ),
        Effect.catchTag('AdminActionError', (failure) =>
          Effect.sync(() => toast.error(failure.message))
        ),
        Effect.ensuring(Effect.sync(() => setIsMakingAdmin(false)))
      )
    )
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,420px)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <ShieldCheck className="text-primary h-5 w-5" />
              WorkOS Enterprise
            </CardTitle>
            <CardDescription>{t('enterpriseDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Una tarjeta no lleva tarjetas adentro: las cinco variables son
                filas de una lista separadas por hairlines, y el nombre entero
                cabe sin truncarse (tarjeta OB-RES-3, «Screens and canvas»). */}
            <ul className="divide-border divide-y">
              {ENV_ITEMS.map((item) => {
                const configured = envStatus[item.key]
                return (
                  <li
                    key={item.key}
                    className="flex items-center justify-between gap-4 py-2 first:pt-0 last:pb-0"
                  >
                    <span className="min-w-0 text-sm font-medium break-all">{item.label}</span>
                    <Badge
                      variant={configured ? 'default' : 'outline'}
                      className={cn(
                        'shrink-0',
                        configured
                          ? 'bg-success text-success-foreground hover:bg-success'
                          : 'border-warning/60 text-warning dark:text-warning'
                      )}
                    >
                      {configured ? t('configured') : t('pending')}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <KeyRound className="text-primary h-5 w-5" />
              {t('portalTitle')}
            </CardTitle>
            <CardDescription>{t('portalDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!isWorkOSConfigured ? (
              <Alert>
                <AlertTitle>{t('pendingTitle')}</AlertTitle>
                <AlertDescription>{t('pendingDescription')}</AlertDescription>
              </Alert>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="workos-organization-id">{t('organizationId')}</Label>
              <Input
                id="workos-organization-id"
                value={organizationId}
                onChange={(event) => setOrganizationId(event.target.value)}
                placeholder="org_..."
                autoComplete="off"
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <Button disabled={!canSubmit} onClick={() => openPortal('sso')}>
                {loadingIntent === 'sso' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ExternalLink className="h-4 w-4" />
                )}
                {t('openSso')}
              </Button>
              <Button
                variant="outline"
                disabled={!canSubmit}
                onClick={() => openPortal('domain_verification')}
              >
                {loadingIntent === 'domain_verification' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GlobeLock className="h-4 w-4" />
                )}
                {t('verifyDomain')}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <CompanyAuthorizationRolloutClient />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <UserCog className="text-primary h-5 w-5" />
            {t('makeAdmin.title')}
          </CardTitle>
          <CardDescription>{t('makeAdmin.help')}</CardDescription>
        </CardHeader>
        <CardContent>
          {/* Un form, no un botón suelto: el navegador valida el email antes de
              que la confirmación y el POST se disparen, y Enter envía. */}
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(event) => {
              event.preventDefault()
              makeAdmin()
            }}
          >
            <div className="w-full space-y-2 sm:max-w-sm">
              <Label htmlFor="make-admin-email">{t('makeAdmin.emailLabel')}</Label>
              <Input
                id="make-admin-email"
                type="email"
                required
                value={adminEmail}
                onChange={(event) => setAdminEmail(event.target.value)}
                placeholder={t('makeAdmin.emailPlaceholder')}
                autoComplete="off"
              />
            </div>
            <Button
              className="w-full sm:w-auto"
              disabled={adminEmail.trim().length === 0 || isMakingAdmin}
              type="submit"
              variant="outline"
            >
              {isMakingAdmin ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('makeAdmin.action')}
            </Button>
          </form>
        </CardContent>
      </Card>

      {message ? (
        <Alert variant={message.type === 'error' ? 'destructive' : 'default'} aria-live="polite">
          <AlertTitle>{message.type === 'error' ? t('alertError') : t('alertReady')}</AlertTitle>
          <AlertDescription>{message.text}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
