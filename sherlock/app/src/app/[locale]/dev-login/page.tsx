// ============================================================================
// DEV LOGIN PAGE
// ============================================================================
// Login simplificado de desarrollo. Solo existe cuando BYPASS_AUTH=true o
// NEXT_PUBLIC_BYPASS_AUTH=true: sin dev-auth, el layout responde `notFound()`.
// ============================================================================

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Schema } from 'effect'
import { useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { decodeSafeReturnTo } from '@/app/[locale]/_shared/safe-return-to'
import { isSupportedLocale } from '@/app/[locale]/_shared/supported-locale'
import { useRouter } from '@/i18n/navigation'
import { useDevAuth, DEV_USERS } from '@/lib/dev-auth'
import { type Locale } from '@/i18n/config'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Building2, Shield, ArrowRight } from 'lucide-react'
import { prepareLocalDevLogin } from './actions'

// ===== VOCABULARIO DE ROLES =====
// `?as=` viene de la URL: es entrada que no controlamos. El vocabulario se
// define una vez y sirve para las dos cosas — decodificar el parámetro y tipar
// las tablas de icono y color, que antes eran objetos sueltos sin relación con
// `DevRole`.
const DevRoleSchema = Schema.Literals(['ADMIN', 'COMPANY'])

type DevRoleName = typeof DevRoleSchema.Type

// El parámetro llega en cualquier caja y puede no venir. `decodeUnknownOption`
// es la pregunta completa: ¿hay valor y es uno de los dos?
const decodeDevRole = Schema.decodeUnknownOption(DevRoleSchema)

// ===== ICONOS POR ROL =====
const roleIcons: Record<DevRoleName, typeof Shield> = {
  ADMIN: Shield,
  COMPANY: Building2,
}

const roleColors: Record<DevRoleName, string> = {
  ADMIN: 'border-accent/40 bg-accent/10 text-accent',
  COMPANY: 'border-accent/40 bg-accent/10 text-accent',
}

export default function DevLoginPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const locale = useLocale()
  const t = useTranslations('devLogin')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [isPreparing, setIsPreparing] = useState(false)
  const autoLoginRequest = useRef<string | null>(null)

  // ===== USAR DEV AUTH =====
  const { signIn } = useDevAuth()

  // Honra ?returnTo= (validado contra open-redirect) para que los flujos que
  // entran por sign-in/sign-up en modo demo conserven su destino original.
  // returnTo llega con prefijo de locale (/es/...); el router i18n vuelve a
  // anteponerlo, así que quitamos el prefijo soportado y navegamos con ese
  // locale explícito.
  const resolveDestination = useCallback((): { href: string; locale: Locale } => {
    const currentLocale = locale as Locale
    const decoded = decodeSafeReturnTo(searchParams.get('returnTo'))
    if (decoded._tag === 'None') {
      return { href: '/onboarding', locale: currentLocale }
    }
    const returnTo = decoded.value
    // El primer segmento del pathname es el candidato a locale, y solo cuenta
    // cuando termina ahí: fin del valor, otro segmento (/), query (?) o
    // fragmento (#). Así /english-corner no se confunde con un locale.
    const head = returnTo.slice(1).split(/[/?#]/, 1)[0] ?? ''
    if (isSupportedLocale(head)) {
      const rest = returnTo.slice(head.length + 1)
      const href = rest === '' || !rest.startsWith('/') ? `/${rest}` : rest
      return { href, locale: head }
    }
    return { href: returnTo, locale: currentLocale }
  }, [searchParams, locale])

  const navigateToDestination = useCallback(() => {
    const destination = resolveDestination()
    router.push(destination.href, { locale: destination.locale })
  }, [resolveDestination, router])

  const login = useCallback(
    async (userEmail: string) => {
      setError('')
      setIsPreparing(true)
      try {
        if (!(await prepareLocalDevLogin())) {
          setError(t('errors.connectionFailed'))
          return
        }
        if (signIn(userEmail)) navigateToDestination()
        else setError(t('errors.emailNotRecognized'))
      } catch {
        setError(t('errors.connectionFailed'))
      } finally {
        setIsPreparing(false)
      }
    },
    [signIn, navigateToDestination, t]
  )

  useEffect(() => {
    const requestedRole = decodeDevRole(searchParams.get('as')?.toUpperCase())
    if (requestedRole._tag === 'None') return
    const user = DEV_USERS.find((candidate) => candidate.role === requestedRole.value)
    if (!user || autoLoginRequest.current === user.email) return
    autoLoginRequest.current = user.email
    void login(user.email)
  }, [searchParams, login])

  const handleEmailLogin = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isPreparing) void login(email)
  }

  return (
    <div className="bg-background text-foreground flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-lg space-y-6">
        {/* ===== HEADER ===== */}
        <div className="space-y-2 text-center">
          <Badge variant="outline" className="border-accent/50 text-accent">
            {t('enabled.badge')}
          </Badge>
          <h1 className="text-3xl font-bold">{t('enabled.title')}</h1>
          <p className="text-muted-foreground">{t('enabled.subtitle')}</p>
        </div>

        {/* ===== QUICK LOGIN CARDS ===== */}
        <div className="grid gap-3">
          {DEV_USERS.map((user) => {
            const Icon = roleIcons[user.role]
            return (
              <Card
                key={user.id}
                className="hover:border-accent/60 hover:bg-accent/5 cursor-pointer transition-colors"
                onClick={() => {
                  if (!isPreparing) void login(user.email)
                }}
              >
                <CardContent className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div className={`rounded-lg p-2 ${roleColors[user.role]}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="font-medium">{user.name}</p>
                      <p className="text-muted-foreground text-sm">{user.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className={roleColors[user.role]}>
                      {user.role}
                    </Badge>
                    <ArrowRight className="text-muted-foreground h-4 w-4" />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>

        {/* ===== DIVIDER ===== */}
        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="border-border w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="text-muted-foreground bg-background px-2">
              {t('enabled.manualDivider')}
            </span>
          </div>
        </div>

        {/* ===== MANUAL EMAIL LOGIN ===== */}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleEmailLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="user@dev.local"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value)
                    setError('')
                  }}
                />
                {error && <p className="text-destructive text-sm">{error}</p>}
                {/* El dev-login no puede saber si el backend local tiene ese
                    dueño: la sala lo dirá. La línea deja a mano el comando que
                    lo siembra. */}
                <p className="text-muted-foreground font-mono text-xs">{t('enabled.seedHint')}</p>
              </div>
              <Button type="submit" className="w-full" disabled={isPreparing}>
                {t('enabled.signIn')}
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ===== FOOTER INFO ===== */}
        <p className="text-muted-foreground text-center text-xs">
          {t('enabled.footerLine1')}
          <br />
          {t('enabled.footerLine2')}
        </p>
      </div>
    </div>
  )
}
