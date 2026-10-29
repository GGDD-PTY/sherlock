'use client'

// ============================================================================
// SECCIONES PLEGADAS DE LA SALA ADMIN — preparación y activación
// ============================================================================
// El Data Room va primero en la sala admin (auditoría 2026-09-06, F02): los dos
// paneles del equipo se pliegan debajo del shell y su resumen dice lo esencial
// sin abrirlos. Un solo `getCompanyChecklist` alimenta los dos resúmenes; los
// paneles siguen siendo dueños de su contenido y de sus mutations.
//
// Un solo vocabulario (F07, AU-03): el sello del equipo se dice «Sala activada»
// / «Sala sin activar»; las siete casillas son «Revisión del equipo: N de 7
// listos» y, mientras falte algo, «Falta: <ítem>». El cliente ve cinco de
// esas casillas en «Tu preparación».
//
// El estado abierto/cerrado se recuerda por empresa en localStorage; por
// defecto todo cerrado. Sin storage (privado, bloqueado) la sección funciona
// igual, solo no recuerda.

// ===== LO QUE CAMBIÓ CON EFFECT =====
// Las siete casillas estaban escritas otra vez acá, y al lado un
// `CHECKLIST_TOTAL = 7` a mano. Tres cosas que tenían que coincidir y ningún
// mecanismo que lo garantizara: agregar una octava casilla al panel dejaba a
// esta pantalla diciendo «N de 7» sobre una lista de ocho. Ahora la lista y su
// total viven una sola vez en `companyChecklistItems`.
//
// El estado guardado en `localStorage` es dato que no controlamos: entra por
// `Schema.Literals` en vez de por una comparación con la cadena `'open'`, y el
// acceso al almacenamiento —que puede tirar en una ventana privada— es un
// programa con su fallo tipado, no un `catch {}`.

import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from 'convex/react'
import { Effect, Option, Schema } from 'effect'
import { useTranslations } from 'next-intl'
import { ChevronRight } from 'lucide-react'

import { api } from '@/../convex/_generated/api'
import type { Id } from '@/../convex/_generated/dataModel'
import {
  CHECKLIST_ITEM_KEYS,
  CHECKLIST_TOTAL,
  type ChecklistItemKey,
} from '@/components/admin/companyChecklistItems'
import { runClientSync } from '@/lib/effect/client-runtime'

type SectionKey = 'preparation' | 'activation'

// Lo único que se guarda por sección. Cualquier otra cosa en la llave —de una
// versión anterior, de otra pestaña, escrita a mano— significa «cerrada».
const OpenStateSchema = Schema.Literals(['open'])
const decodeOpenState = Schema.decodeUnknownOption(OpenStateSchema)

type ChecklistItems = Record<ChecklistItemKey, { done: boolean }>

/** El almacenamiento del navegador rechazó la operación. */
class SectionStoreError extends Schema.TaggedError<SectionStoreError>()('SectionStoreError', {
  operation: Schema.Literals(['read', 'write']),
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

function storageKey(companyId: string, section: SectionKey) {
  return `sherlock:admin-room:${companyId}:${section}`
}

const readOpen = Effect.fn('AdminRoomSections.readOpen')(
  function* (companyId: string, section: SectionKey) {
    const raw = yield* Effect.try({
      try: () => window.localStorage.getItem(storageKey(companyId, section)),
      catch: (cause) => new SectionStoreError({ operation: 'read', cause }),
    })
    return Option.isSome(decodeOpenState(raw))
  },
  // Sin almacenamiento legible la sección arranca cerrada, igual que antes.
  Effect.catchTag('SectionStoreError', () => Effect.succeed(false))
)

const writeOpen = Effect.fn('AdminRoomSections.writeOpen')(
  function* (companyId: string, section: SectionKey, open: boolean) {
    yield* Effect.try({
      try: () => {
        if (open) window.localStorage.setItem(storageKey(companyId, section), 'open')
        else window.localStorage.removeItem(storageKey(companyId, section))
      },
      catch: (cause) => new SectionStoreError({ operation: 'write', cause }),
    })
  },
  // Sin storage la sección sigue abriendo y cerrando; solo no recuerda.
  Effect.catchTag('SectionStoreError', () => Effect.void)
)

function firstMissing(items: ChecklistItems): ChecklistItemKey | null {
  return CHECKLIST_ITEM_KEYS.find((key) => !items[key]?.done) ?? null
}

function AdminRoomSection({
  companyId,
  section,
  summary,
  detail,
  children,
}: {
  companyId: string
  section: SectionKey
  summary: string
  detail: string | null
  children: ReactNode
}) {
  // Cerrado en el servidor y en el primer render; lo recordado entra después
  // del montaje para no discutir con la hidratación.
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(runClientSync(readOpen(companyId, section)))
  }, [companyId, section])

  return (
    <details
      data-testid={`admin-room-section-${section}`}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open
        setOpen(next)
        runClientSync(writeOpen(companyId, section, next))
      }}
      className="group border-border border-t pt-6"
    >
      <summary
        data-testid={`admin-room-summary-${section}`}
        className="focus-visible:ring-ring flex cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 rounded-sm outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
      >
        <ChevronRight
          className="h-4 w-4 shrink-0 self-center transition-transform duration-[180ms] group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        <span className="font-display text-xl leading-tight">{summary}</span>
        {detail ? <span className="text-muted-foreground text-sm">{detail}</span> : null}
      </summary>
      <div className="mt-6">{children}</div>
    </details>
  )
}

export function AdminRoomSections({
  companyId,
  isDemo = false,
  preparation,
  activation,
}: {
  companyId: Id<'companies'>
  isDemo?: boolean
  preparation: ReactNode
  activation: ReactNode
}) {
  const t = useTranslations('adminRoomActivation')
  const checklist = useQuery(
    api.companyChecklist.getCompanyChecklist,
    isDemo ? 'skip' : { companyId }
  )

  const missing = checklist ? firstMissing(checklist.items) : null
  const preparationSummary = checklist
    ? t('preparationSummary', { ready: checklist.completedCount, total: CHECKLIST_TOTAL })
    : t('preparationTitle')
  const preparationDetail = missing
    ? t('preparationMissing', { item: t(`items.${missing}`) })
    : null
  const activationSummary = checklist
    ? checklist.activation.active
      ? t('available')
      : t('notActivated')
    : t('title')
  const activationDetail = checklist
    ? checklist.activation.active
      ? t('availableHint')
      : t('notActivatedHint')
    : null

  return (
    <div className="space-y-8">
      <AdminRoomSection
        companyId={companyId}
        section="preparation"
        summary={preparationSummary}
        detail={preparationDetail}
      >
        {preparation}
      </AdminRoomSection>
      {/* El panel de activación no existe en la sala demo (devuelve null):
          no se pinta una sección vacía. */}
      {isDemo ? null : (
        <AdminRoomSection
          companyId={companyId}
          section="activation"
          summary={activationSummary}
          detail={activationDetail}
        >
          {activation}
        </AdminRoomSection>
      )}
    </div>
  )
}
