import { Schema } from 'effect'

import { Skeleton } from '@/components/ui/skeleton'

// Un solo esqueleto para dos consumidores (el fallback de la ruta y la espera de
// la suscripción de Convex) para que el layout no salte entre ambos.
//
// Cuatro tarjetas de resumen, seis filas de actividad: el catálogo vive en el
// schema y el render lo recorre; no hay variante ni dato de fuera que guardar.
const SummaryCardKeySchema = Schema.Literals([1, 2, 3, 4])
const ActivityRowKeySchema = Schema.Literals([1, 2, 3, 4, 5, 6])

export function ActivitySkeleton() {
  return (
    <div data-testid="activity-skeleton" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <Skeleton className="mb-2 h-8 w-72" />
      <Skeleton className="mb-8 h-4 w-96 max-w-full" />
      <div className="mb-8 grid gap-4 md:grid-cols-4">
        {SummaryCardKeySchema.literals.map((key) => (
          <Skeleton key={key} className="h-24" />
        ))}
      </div>
      <Skeleton className="mb-4 h-9 w-64" />
      <div className="border-line space-y-2 rounded-md border p-4">
        {ActivityRowKeySchema.literals.map((key) => (
          <Skeleton key={key} className="h-10" />
        ))}
      </div>
    </div>
  )
}
