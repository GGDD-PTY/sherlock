'use client'

import { Component, useState, type ErrorInfo, type ReactNode } from 'react'
import { ArrowLeft, RefreshCcw, ShieldAlert } from 'lucide-react'
import { Schema } from 'effect'

import { Button } from '@/components/ui/button'
import { Link, useRouter } from '@/i18n/navigation'
import type { VdrLocale } from './types'
import { serializeWorkspaceUrlState, type VdrWorkspaceUrlState } from './workspace-url-state'

// El enlace de vuelta a la biblioteca escribía la query a mano. Era una segunda
// copia del formato que `serializeWorkspaceUrlState` ya conoce: el día que la
// sala cambie un parámetro, la pantalla de fallo es la que se queda apuntando a
// una URL vieja, y es justo la pantalla desde la que el cliente intenta salir
// del problema. Ahora sale del mismo serializador que el resto de la sala.
const COMPANY_LIBRARY_STATE: VdrWorkspaceUrlState = {
  room: { kind: 'COMPANY', id: 'company' },
  view: 'documents',
  category: 'all',
  search: '',
}
const COMPANY_LIBRARY_HREF = serializeWorkspaceUrlState(
  '/my-company/documents',
  COMPANY_LIBRARY_STATE
)

const recoveryCopy = {
  es: {
    eyebrow: 'Data room seguro',
    title: 'No pudimos cargar este espacio',
    description:
      'Tus documentos no se modificaron. Intenta cargar el espacio nuevamente o vuelve a la biblioteca de la empresa.',
    retry: 'Intentar de nuevo',
    returnToLibrary: 'Volver a la biblioteca',
  },
} as const

type FailureProps = {
  locale: VdrLocale
  onRetry: () => void
}

export function VdrWorkspaceFailure({ locale, onRetry }: FailureProps) {
  const copy = recoveryCopy[locale]

  return (
    <div className="bg-background min-h-[70dvh] px-4 py-10 sm:px-6 lg:px-8">
      <section
        role="alert"
        aria-live="assertive"
        aria-labelledby="vdr-workspace-error-title"
        className="border-border bg-card mx-auto max-w-2xl rounded-lg border p-6 shadow-sm sm:p-8"
      >
        <div className="border-border border-b pb-5">
          <p className="text-primary flex items-center gap-2 text-xs font-semibold tracking-widest uppercase">
            <ShieldAlert className="h-4 w-4" aria-hidden />
            {copy.eyebrow}
          </p>
          <h1
            id="vdr-workspace-error-title"
            data-page-identity
            className="font-display mt-3 text-2xl leading-tight font-normal sm:text-[2rem]"
          >
            {copy.title}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-xl text-sm leading-6 sm:text-base">
            {copy.description}
          </p>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button type="button" onClick={onRetry} className="min-h-11">
            <RefreshCcw className="mr-2 h-4 w-4" aria-hidden />
            {copy.retry}
          </Button>
          <Button variant="outline" asChild className="min-h-11">
            <Link href={COMPANY_LIBRARY_HREF}>
              <ArrowLeft className="mr-2 h-4 w-4" aria-hidden />
              {copy.returnToLibrary}
            </Link>
          </Button>
        </div>
      </section>
    </div>
  )
}

/**
 * La misma pantalla, para un fallo que ocurrió en el servidor: la página no
 * puede pasarle un `onRetry` a un componente de cliente, así que el reintento
 * lo pone acá `router.refresh()`, que vuelve a correr la carga del servidor.
 */
export function VdrWorkspaceReloadFailure({ locale }: { locale: VdrLocale }) {
  const router = useRouter()

  return <VdrWorkspaceFailure locale={locale} onRetry={() => router.refresh()} />
}

type ErrorBoundaryProps = {
  children: ReactNode
  fallback: ReactNode
}

type ErrorBoundaryState = { failed: boolean }

// ===== LA COSTURA CON EFFECT =====
// `componentDidCatch` se traga el error a propósito: lo que cruza por ahí puede
// traer contenido de documento o identidad del cliente, y este boundary no
// tiene a dónde mandarlo sin arriesgar una fuga (`src/components/AGENTS.md`:
// "nunca render o leak provider payloads... via props, logs, toasts,
// analytics"). Antes ese propósito vivía solo en un comentario, que un cambio
// futuro puede borrar sin darse cuenta de qué garantía se llevó. Ahora el
// error atrapado tiene nombre — `VdrWorkspaceRenderError` — así que el
// silencio es una decisión de tipo, no de omisión: construirlo y no usarlo
// para nada más que ese nombre es la prueba en el código de que el boundary
// sabe lo que descarta.
class VdrWorkspaceRenderError extends Schema.TaggedError<VdrWorkspaceRenderError>()(
  'VdrWorkspaceRenderError',
  { cause: Schema.Defect() }
) {}

class VdrRenderErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, _errorInfo: ErrorInfo) {
    // Se nombra y se descarta: nunca console.error, nunca analytics, nunca
    // Sentry. El fallback (`VdrWorkspaceFailure`) es la única salida visible.
    const _caught = new VdrWorkspaceRenderError({ cause: error })
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}

type Props = {
  children: ReactNode
  locale: VdrLocale
  onRetry?: () => void
}

export function VdrWorkspaceErrorBoundary({ children, locale, onRetry }: Props) {
  const router = useRouter()
  const [attempt, setAttempt] = useState(0)

  const retry = () => {
    if (onRetry) onRetry()
    else router.refresh()
    setAttempt((current) => current + 1)
  }

  return (
    <VdrRenderErrorBoundary
      key={attempt}
      fallback={<VdrWorkspaceFailure locale={locale} onRetry={retry} />}
    >
      {children}
    </VdrRenderErrorBoundary>
  )
}
