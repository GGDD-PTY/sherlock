'use client'

import { useEffect, useState } from 'react'
import { Array as Arr, Option } from 'effect'

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'

export type HelpCenterItem = {
  /** Ancla de la fila: la sala enlaza `/es/ayuda#mcp` desde «Conecta tu agente». */
  readonly id: string
  readonly q: string
  readonly a: string
}

// `decodeURIComponent` lanza `URIError` con un porcentaje suelto (`#%`), y esto
// corre dentro de un efecto: sin la costura, una URL mal escrita tumba la
// página entera en vez de no abrir ninguna fila.
const decodeHash = Option.liftThrowable(decodeURIComponent)

/**
 * El hash es entrada externa: solo abre una fila si nombra una de las claves
 * que esta página publicó. `Option` en vez de `null` porque «no hay hash», «el
 * hash no se puede decodificar» y «el hash no es de aquí» son el mismo caso
 * para quien llama.
 */
function itemIdFromHash(hash: string, items: readonly HelpCenterItem[]): Option.Option<string> {
  return decodeHash(hash.replace(/^#/, '')).pipe(
    Option.flatMap((candidate) => Arr.findFirst(items, (item) => item.id === candidate)),
    Option.map((item) => item.id)
  )
}

/**
 * El acordeón de la ayuda. Es la única parte de cliente de la pantalla: existe
 * porque el hash de la URL solo se conoce en el navegador, y porque
 * `/es/ayuda#mcp` tiene que aterrizar con SU pregunta abierta (tarjeta O4-02).
 * Sin hash todo arranca cerrado, que es como se mide la pantalla.
 */
export function HelpCenterAccordion({ items }: { items: readonly HelpCenterItem[] }) {
  const [openItem, setOpenItem] = useState('')

  useEffect(() => {
    // El hash manda sobre la fila abierta: volver atrás hasta `/es/ayuda` sin
    // ancla deja la pantalla como se mide, con todo cerrado.
    function openFromHash() {
      setOpenItem(Option.getOrElse(itemIdFromHash(window.location.hash, items), () => ''))
    }

    openFromHash()
    // Llegar dos veces al mismo hash desde la sala no recarga la página: el
    // navegador solo emite `hashchange`.
    window.addEventListener('hashchange', openFromHash)
    return () => {
      window.removeEventListener('hashchange', openFromHash)
    }
  }, [items])

  return (
    <Accordion
      type="single"
      collapsible
      value={openItem}
      onValueChange={setOpenItem}
      className="w-full"
    >
      {items.map((item) => (
        <AccordionItem
          key={item.id}
          id={item.id}
          value={item.id}
          // `scroll-mt` para que la navbar fija no tape la pregunta cuando se
          // llega por ancla (`/es/ayuda#mcp`).
          className="border-border-hairline scroll-mt-20"
        >
          <AccordionTrigger className="py-2.5 text-sm leading-snug font-medium">
            {item.q}
          </AccordionTrigger>
          <AccordionContent className="text-muted-foreground max-w-prose text-base leading-relaxed">
            {item.a}
          </AccordionContent>
        </AccordionItem>
      ))}
    </Accordion>
  )
}
