'use client'

import { useEffect } from 'react'
import { Effect, Schema } from 'effect'
import { AlertTriangle, RefreshCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { captureClientException } from '@/lib/observability/capture-client-exception'
import { THEME_BOOT_SCRIPT } from '@/lib/theme/boot-script'
import { runClientFork } from '@/lib/effect/client-runtime'
import esMessages from '@/messages/es.json'

interface GlobalErrorProps {
  readonly error: Error & { readonly digest?: string }
  readonly reset: () => void
}

// El boundary reemplaza el layout raíz, así que no puede leer next-intl. El
// sitio sirve un solo idioma, de modo que la tarjeta se arma en español desde el
// primer byte del servidor y no hay detección de idioma que hidratar.
const GLOBAL_ERROR_COPY = {
  title: esMessages.errors.globalError.title,
  description: esMessages.errors.globalError.body,
  retry: esMessages.errors.globalError.cta,
  reference: esMessages.errors.globalError.reference,
} as const

interface GlobalErrorCopy {
  readonly title: string
  readonly description: string
  readonly retry: string
  readonly reference: string
}

// El `digest` lo pone el servidor y llega a esta pantalla como dato del que no
// controlamos la forma: se pinta en la tarjeta, así que se decodifica antes.
// Lo que se acepta está escrito una vez, en el esquema, en vez de repartido
// entre un trim y un regex sueltos.
const SafeDigestSchema = Schema.Trim.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)))

const decodeSafeDigest = Schema.decodeUnknownOption(SafeDigestSchema)

function getSafeDigest(digest: string | undefined): string | null {
  const decoded = decodeSafeDigest(digest)
  return decoded._tag === 'Some' ? decoded.value : null
}

// Reportar no puede tumbar la pantalla: `runFork` aísla el fallo en su propia
// fibra en vez de lanzarlo dentro del efecto de React. Corre en el borde.
const reportGlobalError = Effect.fn('GlobalError.report')(function* (
  error: GlobalErrorProps['error']
) {
  yield* Effect.sync(() => captureClientException(error, error.digest))
  yield* Effect.logError('[Global Error]', error)
})

function GlobalErrorCard({
  copy,
  digest,
  reset,
}: {
  readonly copy: GlobalErrorCopy
  readonly digest: string | null
  readonly reset: () => void
}) {
  return (
    <div
      className="bg-card border-border flex w-full max-w-md flex-col items-center rounded-xl border p-8 text-center shadow-sm"
      role="alert"
      aria-live="assertive"
    >
      <div className="bg-destructive/10 text-destructive mb-6 flex h-16 w-16 items-center justify-center rounded-full">
        <AlertTriangle size={32} aria-hidden="true" />
      </div>
      <h1 className="mb-2 text-2xl font-bold">{copy.title}</h1>
      <p className="text-muted-foreground mb-8 leading-relaxed">{copy.description}</p>
      <Button onClick={reset} size="lg" className="w-full sm:w-auto">
        <RefreshCcw className="mr-2 h-4 w-4" aria-hidden="true" />
        {copy.retry}
      </Button>
      {digest ? (
        <div className="border-border mt-8 w-full border-t pt-6">
          <p className="text-muted-foreground font-mono text-xs">
            {copy.reference} {digest}
          </p>
        </div>
      ) : null}
    </div>
  )
}

export default function GlobalError({ error, reset }: GlobalErrorProps) {
  const digest = getSafeDigest(error.digest)

  useEffect(() => {
    runClientFork(reportGlobalError(error))
  }, [error])

  // Reemplaza el layout raíz, así que no hereda el ThemeProvider ni su boot
  // script: sin este <head> la pantalla de error ignora el tema del usuario.
  const themeBoot = (
    <head>
      <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
    </head>
  )

  return (
    <html lang="es" suppressHydrationWarning>
      {themeBoot}
      <body className="bg-background text-foreground flex min-h-screen items-center justify-center p-4 font-sans">
        <GlobalErrorCard copy={GLOBAL_ERROR_COPY} digest={digest} reset={reset} />
      </body>
    </html>
  )
}
