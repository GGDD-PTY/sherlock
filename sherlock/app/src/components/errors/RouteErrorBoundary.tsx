import { useTranslations } from 'next-intl'
import { Option, Schema } from 'effect'
import { AlertTriangle, Home, RefreshCcw } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

// El `digest` lo produce el runtime de Next y termina impreso en pantalla: es
// entrada que este componente no controla y por eso se decodifica en vez de
// pintarse. La forma —recortado, no vacío, sin nada fuera del alfabeto del
// runtime, con techo— ahora está declarada en un solo lugar.
const SafeDigestSchema = Schema.Trim.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)))
const decodeSafeDigest = Schema.decodeUnknownOption(SafeDigestSchema)

export type RouteErrorBoundaryProps = {
  readonly error: Error & { readonly digest?: string }
  readonly reset: () => void
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
}

export function RouteErrorBoundary({ error, reset, headingLevel = 1 }: RouteErrorBoundaryProps) {
  const t = useTranslations('errors.boundary')
  const digest = Option.getOrNull(decodeSafeDigest(error.digest))

  return (
    <div className="container mx-auto flex min-h-[60vh] items-center justify-center px-4 py-12">
      <Card className="w-full max-w-lg" role="alert" aria-live="assertive">
        <CardHeader className="text-center">
          <div className="bg-destructive/10 text-destructive mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full">
            <AlertTriangle className="h-6 w-6" aria-hidden="true" />
          </div>
          <CardTitle className="text-2xl" role="heading" aria-level={headingLevel}>
            {t('title')}
          </CardTitle>
          <CardDescription>{t('description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {digest ? (
            <p className="text-muted-foreground text-center font-mono text-xs">
              {t('reference', { digest })}
            </p>
          ) : null}
          <div className="flex flex-col gap-3 sm:flex-row">
            <Button onClick={reset} className="flex-1">
              <RefreshCcw className="h-4 w-4" aria-hidden="true" />
              {t('retry')}
            </Button>
            <Button variant="outline" className="flex-1" asChild>
              <Link href="/">
                <Home className="h-4 w-4" aria-hidden="true" />
                {t('returnHome')}
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
