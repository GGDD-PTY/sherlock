// ============================================================================
// LOADING STATE - DATA ROOM (MY COMPANY DOCUMENTS)
// ============================================================================
// Misma identidad y misma silueta que el aria-busy interno de la sala:
// h1 sans text-lg, franja de portada y lista. Sin tarjetas de stats.
// ============================================================================

import { Schema } from 'effect'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from 'next-intl'

const PAGE_IDENTITY_CLASS =
  'text-foreground font-sans text-lg leading-tight font-medium tracking-normal'

const LoadingBlockSchema = Schema.Literals(['cover', 'list'])
const LOADING_BLOCK_CLASS = {
  cover: 'h-28 motion-reduce:animate-none',
  list: 'h-96 motion-reduce:animate-none',
} as const satisfies Record<typeof LoadingBlockSchema.Type, string>

export default function MyCompanyDocumentsLoading() {
  const t = useTranslations('common.navbar')

  return (
    <div
      className="min-h-[70dvh] w-full px-3 py-4 sm:px-4 lg:px-6"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h1 data-page-identity className={PAGE_IDENTITY_CLASS}>
          {t('dataRoom')}
        </h1>
        <Skeleton className="h-4 w-48 max-w-full motion-reduce:animate-none" />
      </div>
      <div className="mt-4 space-y-5">
        {LoadingBlockSchema.literals.map((block) => (
          <Skeleton key={block} className={LOADING_BLOCK_CLASS[block]} />
        ))}
      </div>
    </div>
  )
}
