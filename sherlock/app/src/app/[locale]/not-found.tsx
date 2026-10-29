// ============================================================================
// 404 NOT FOUND PAGE
// ============================================================================
// Página personalizada para rutas que no existen
// Muestra un mensaje amigable y enlaces para navegar
// ============================================================================

import { Effect, Schema } from 'effect'
import { getTranslations } from 'next-intl/server'
import { Button } from '@/components/ui/button'
import { SignInLink } from '@/components/layout/SignInLink'
import { Link } from '@/i18n/navigation'
import { runServerEffect } from '@/lib/effect/runtime'
import { PublicRouteSchema } from '@/lib/product/public-routes'
import { FileQuestion, Home, Search } from 'lucide-react'

// Los destinos de router se decodifican contra el catálogo compartido al cargar
// el módulo, igual que en `global-not-found.tsx`. La puerta de sesión no está
// aquí: es navegación de documento y la pone `SignInLink`.
const decodePublicRoute = Schema.decodeSync(PublicRouteSchema)
const HOME_PATH = decodePublicRoute('/')
const HELP_PATH = decodePublicRoute('/ayuda')

class NotFoundCopyError extends Schema.TaggedError<NotFoundCopyError>()('NotFoundCopyError', {
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const loadNotFoundCopy = Effect.fn('NotFound.loadCopy')(function* () {
  return yield* Effect.tryPromise({
    try: () => getTranslations('notFound'),
    catch: (cause) => new NotFoundCopyError({ cause }),
  })
})

export default async function NotFound() {
  const t = await runServerEffect(loadNotFoundCopy())

  return (
    <div className="flex min-h-[70vh] flex-col items-center justify-center px-4 text-center">
      {/* ===== ICON ===== */}
      <div className="bg-muted mb-8 flex h-24 w-24 items-center justify-center rounded-full">
        <FileQuestion className="text-muted-foreground h-12 w-12" />
      </div>

      {/* ===== MESSAGE ===== */}
      <h1 className="text-4xl font-bold tracking-tight">{t('title404')}</h1>
      <h2 className="mt-2 text-2xl font-semibold">{t('heading')}</h2>
      <p className="text-muted-foreground mt-4 max-w-md">{t('message')}</p>

      {/* ===== ACTIONS ===== */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
        <Button asChild>
          <Link href={HOME_PATH}>
            <Home className="mr-2 h-4 w-4" />
            {t('goHome')}
          </Link>
        </Button>
        <Button variant="outline" asChild>
          <Link href={HELP_PATH}>
            <Search className="mr-2 h-4 w-4" />
            {t('contactUs')}
          </Link>
        </Button>
      </div>

      {/* ===== HELPFUL LINKS ===== */}
      <div className="bg-muted/50 mt-12 rounded-lg border p-6">
        <h3 className="mb-4 font-semibold">{t('popularPages')}</h3>
        <div className="flex flex-wrap items-center justify-center gap-4">
          <Link
            href={HELP_PATH}
            className="text-muted-foreground hover:text-foreground text-sm hover:underline"
          >
            {t('contactUs')}
          </Link>
          <span className="text-muted-foreground">•</span>
          {/* Misma puerta que la barra: `/sign-in` termina en WorkOS, otro
              origen, así que va por navegación de documento y no por el router. */}
          <SignInLink className="text-muted-foreground hover:text-foreground text-sm hover:underline">
            {t('access')}
          </SignInLink>
        </div>
      </div>

      {/* ===== SUPPORT ===== */}
      <p className="text-muted-foreground mt-8 text-sm">
        {t('askHelp')}{' '}
        <Link href={HELP_PATH} className="text-primary hover:underline">
          {t('contactUs')}
        </Link>
      </p>
    </div>
  )
}
