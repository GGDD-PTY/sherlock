// ============================================================================
// USE-TOAST HOOK
// ============================================================================
// Hook simple para mostrar notificaciones toast. Implementado con sonner
// (shadcn/ui).
//
// ===== VARIANTES =====
// Un toast no falla y no espera, así que acá no hay programa que correr. Pero
// `variant` sí es una prop: TypeScript la tipa en cada call site, pero nada
// impide en runtime que llegue otra cosa — un `as ToastOptions`, un mensaje de
// error armado desde un `switch` con un caso mal escrito, un valor que viene de
// una respuesta de API tipada `any` en el camino. Esta unión de variantes
// también estaba escrita a mano en cada componente que armaba sus propias
// opciones; `Schema.Literals` la define una vez y el hook decide sobre la
// misma definición, no sobre lo que el caller haya escrito.
// ============================================================================

import { useCallback } from 'react'
import { Schema } from 'effect'
import { toast as sonnerToast } from 'sonner'

/** Las variantes que este hook sabe pintar. Una sola definición. */
const ToastVariantSchema = Schema.Literals(['default', 'destructive'])
type ToastVariant = typeof ToastVariantSchema.Type
const isToastVariant = Schema.is(ToastVariantSchema)

export interface ToastOptions {
  title: string
  description?: string
  variant?: ToastVariant
}

export function useToast() {
  const toast = useCallback(({ title, description, variant }: ToastOptions) => {
    // Variante desconocida -> se pinta como 'default' en vez de reventar el
    // toast completo. Un aviso que no se muestra es peor que uno con el color
    // equivocado.
    const safeVariant = variant !== undefined && isToastVariant(variant) ? variant : 'default'

    if (safeVariant === 'destructive') {
      sonnerToast.error(title, { description })
      return
    }

    sonnerToast(title, { description })
  }, [])

  return { toast }
}
