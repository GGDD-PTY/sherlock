import { useTranslations } from 'next-intl'
import { Schema } from 'effect'
import type { ComponentType } from 'react'

import AdminLoading from '@/app/[locale]/(app)/admin/loading'
import CompanyLoading from '@/app/[locale]/(app)/my-company/loading'
import { RouteErrorBoundary } from '@/components/errors/RouteErrorBoundary'

const RouteFamilySchema = Schema.Literals(['company', 'admin'])
type RouteFamily = typeof RouteFamilySchema.Type
const isRouteFamily = Schema.is(RouteFamilySchema)
const FALLBACK_ROUTE_FAMILY: RouteFamily = 'company'

class SyntheticShowcaseError extends Error {
  readonly digest: string

  constructor(family: RouteFamily) {
    super('Synthetic showcase error')
    this.digest = `SYN-${family.toUpperCase()}-ERROR`
  }
}

const LOADING_SURFACES = {
  company: CompanyLoading,
  admin: AdminLoading,
} satisfies Record<RouteFamily, ComponentType>

export function RouteStateShowcase() {
  const t = useTranslations('designSystem')

  return (
    <section aria-labelledby="route-states-title" className="border-border border-t pt-8">
      <h2 id="route-states-title" className="font-display text-2xl">
        {t('routeStates.title')}
      </h2>
      <p className="text-muted-foreground mt-2 text-sm">{t('routeStates.description')}</p>
      <div className="mt-6 space-y-4">
        {RouteFamilySchema.literals.map((name) => {
          const family = isRouteFamily(name) ? name : FALLBACK_ROUTE_FAMILY
          const LoadingSurface = LOADING_SURFACES[family]

          return (
            <div key={family} className="grid gap-4 lg:grid-cols-2">
              <details
                data-testid={`route-loading-${family}`}
                className="border-border bg-card rounded-md border"
              >
                <summary className="cursor-pointer p-4 font-medium">
                  {t('routeStates.loadingLabel', { family: t(`routeStates.${family}`) })}
                </summary>
                {/* Muestra visual: el esqueleto trae el h1 de identidad de la
                    página y una región viva; ninguno pertenece al outline de la
                    vitrina, así que no entra al árbol de accesibilidad. */}
                <div className="border-border max-h-96 overflow-auto border-t" aria-hidden="true">
                  <LoadingSurface />
                </div>
              </details>
              <details
                data-testid={`route-error-${family}`}
                className="border-border bg-card rounded-md border"
              >
                <summary className="cursor-pointer p-4 font-medium">
                  {t('routeStates.errorLabel', { family: t(`routeStates.${family}`) })}
                </summary>
                <div className="border-border max-h-96 overflow-auto border-t">
                  <RouteErrorBoundary
                    error={new SyntheticShowcaseError(family)}
                    reset={() => undefined}
                    headingLevel={3}
                  />
                </div>
              </details>
            </div>
          )
        })}
      </div>
    </section>
  )
}
