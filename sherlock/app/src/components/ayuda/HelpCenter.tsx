// ============================================================================
// DOCS DEL HUB DE AYUDA
// ============================================================================
// Era el Centro de Ayuda completo: seis categorías en tarjetas, buscador con
// fold de diacríticos y un bloque de contacto propio. Todo eso salió con el hub
// ([F] 2026-09-01: «menos copy, menos cards»). Lo operativo cabe en seis
// preguntas y el contacto ya vive arriba, en la única caja de texto de la
// página — un buscador aquí sería el segundo campo de texto de la pantalla,
// que es justo el bug reportado el 2026-08-27.
//
// Sin 'use client': la sección y su título son servidor. Lo único que corre en
// el navegador es el acordeón (`HelpCenterAccordion`), porque el hash de la URL
// no existe del lado del servidor.
// ============================================================================

import { Schema } from 'effect'

import { HelpCenterAccordion, type HelpCenterItem } from '@/components/ayuda/HelpCenterAccordion'
import { cn } from '@/lib/utils'

export type HelpCenterCopy = {
  readonly heading: string
  readonly items: readonly HelpCenterItem[]
}

// Camino 2: `copy` llega tipada por TypeScript, pero en runtime nada impide
// que una pregunta o respuesta vacía llegue aquí (una clave de `es.json`
// faltante, por ejemplo). `item.id` también hace de key de React y de ancla:
// una fila sin texto sería un trigger de acordeón sin nombre accesible.
// Se filtra, no se revienta la página por una sola fila mala.
const HelpCenterItemSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  q: Schema.NonEmptyString,
  a: Schema.NonEmptyString,
})
const isHelpCenterItem = Schema.is(HelpCenterItemSchema)

// `className` existe solo para que la página coloque la sección en su grid
// (fila 2 de la columna izquierda) sin envolverla en un div sin semántica.
export function HelpCenter({ copy, className }: { copy: HelpCenterCopy; className?: string }) {
  const items = copy.items.filter(isHelpCenterItem)

  return (
    <section
      aria-labelledby="ayuda-docs-heading"
      className={cn('grid content-start gap-3', className)}
    >
      <h2 id="ayuda-docs-heading" className="font-sans text-base leading-tight font-semibold">
        {copy.heading}
      </h2>
      {/* Sin caja exterior: las filas se separan por hairlines. Las filas van a
          12px de padding: las preguntas cerradas caben bajo el formulario sin
          empujar nada. */}
      <HelpCenterAccordion items={items} />
    </section>
  )
}
