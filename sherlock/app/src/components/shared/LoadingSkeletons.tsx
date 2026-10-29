import { Schema } from 'effect'

import { Skeleton } from '@/components/ui/skeleton'

// Tres formas de esqueleto que tres `loading.tsx` distintos escribían a mano,
// dos de ellas por partida doble con el mismo ancho. Vivir una vez evita que
// la cuarta copia diverja por accidente.

const LoadingSkeletonKindSchema = Schema.Literals(['header', 'toggleRow', 'listRow'])
type LoadingSkeletonKind = typeof LoadingSkeletonKindSchema.Type
const isLoadingSkeletonKind = Schema.is(LoadingSkeletonKindSchema)
const isClassName = Schema.is(Schema.String)

function loadingSkeletonTestId(kind: LoadingSkeletonKind) {
  const safeKind = isLoadingSkeletonKind(kind) ? kind : 'header'
  return `loading-skeleton-${safeKind}` as const
}

// Encabezado de página: título + subtítulo. Idéntico, ancho por ancho, en
// my-company/loading.tsx, settings/loading.tsx y settings/privacy/loading.tsx.
export function PageHeaderSkeleton() {
  return (
    <div className="mb-8" data-testid={loadingSkeletonTestId('header')}>
      <Skeleton className="mb-2 h-9 w-48" />
      <Skeleton className="h-5 w-72" />
    </div>
  )
}

// Fila de ajuste: etiqueta + descripción + switch. settings/loading.tsx y
// settings/privacy/loading.tsx la repetían igual salvo el ancho de la
// descripción.
export function ToggleRowSkeleton({
  descriptionClassName = 'h-3 w-48',
}: {
  descriptionClassName?: string
}) {
  const safeDescriptionClassName = isClassName(descriptionClassName)
    ? descriptionClassName
    : 'h-3 w-48'
  return (
    <div
      className="flex items-center justify-between"
      data-testid={loadingSkeletonTestId('toggleRow')}
    >
      <div className="space-y-1">
        <Skeleton className="h-4 w-32" />
        <Skeleton className={safeDescriptionClassName} />
      </div>
      <Skeleton className="h-6 w-12 rounded-full" />
    </div>
  )
}

// Fila de lista: avatar + título/subtítulo + badge. my-company/loading.tsx
// (tarjeta de contenido) y admin/loading.tsx (tabla) la repetían igual salvo
// la forma del avatar.
export function ListRowSkeleton({
  avatarClassName = 'h-10 w-10 rounded-lg',
}: {
  avatarClassName?: string
}) {
  const safeAvatarClassName = isClassName(avatarClassName)
    ? avatarClassName
    : 'h-10 w-10 rounded-lg'
  return (
    <div
      className="flex items-center justify-between rounded-lg border p-4"
      data-testid={loadingSkeletonTestId('listRow')}
    >
      <div className="flex items-center gap-4">
        <Skeleton className={safeAvatarClassName} />
        <div>
          <Skeleton className="mb-2 h-4 w-40" />
          <Skeleton className="h-3 w-28" />
        </div>
      </div>
      <Skeleton className="h-6 w-20 rounded-full" />
    </div>
  )
}
