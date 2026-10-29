'use client'

import { Schema } from 'effect'
import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react'
import { useSyncExternalStore } from 'react'
import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { ThemeSchema } from '@/components/providers/theme-schema'
import { useTheme } from '@/components/providers/ThemeProvider'

const emptySubscribe = () => () => {}

const TOAST_DURATION_MS = 4_000
// Solo el borde superior: sonner conserva su default en los otros tres, así que
// el toast no se estrecha en un teléfono.
const NAVBAR_CLEARANCE = { top: '5rem' } as const

// El tema lo decodifica el provider, pero Toaster también lo acepta por props
// y sonner solo pinta `light` | `dark` | `system`. Un string cualquiera
// desactiva el tema sin aviso. El guard cae a light (mismo fallback que el SSR).
const isToasterTheme = Schema.is(ThemeSchema)

// Las seis anclas de sonner (`Position` en `sonner/dist/index.d.ts`). Un valor
// fuera del catálogo manda el toast a un rincón que el CSS no cubre. El guard
// cae a top-right, que es el ancla de la app.
const ToasterPositionSchema = Schema.Literals([
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
  'top-center',
  'bottom-center',
])
type ToasterPosition = typeof ToasterPositionSchema.Type
const isToasterPosition = Schema.is(ToasterPositionSchema)

const Toaster = ({ theme: themeFromProps, position, ...props }: ToasterProps) => {
  const { theme: providerTheme = 'system' } = useTheme()
  const requestedTheme = themeFromProps ?? providerTheme
  const safeTheme = isToasterTheme(requestedTheme) ? requestedTheme : 'light'
  const safePosition: ToasterPosition | undefined =
    position === undefined ? undefined : isToasterPosition(position) ? position : 'top-right'
  // El provider ya decodificó el tema. Gateamos por hidratación
  // (useSyncExternalStore: snapshot servidor=false, cliente=true) para que el
  // primer render hidratado coincida con el SSR. `theme` y `position` salen
  // del spread para que un override por props no pise el gate ni el catálogo.
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  )

  return (
    <Sonner
      theme={mounted ? safeTheme : 'light'}
      position={safePosition}
      // Ambos van ANTES del spread: son los valores por defecto de la app y
      // quien monta el Toaster los puede reemplazar. La duración se fija en vez
      // de heredarse para que el aviso de "documento subido" no se quede en
      // pantalla; el offset baja el viewport por debajo del navbar de 4rem, que
      // es lo que antes tapaba Notificaciones y Preferencias.
      duration={TOAST_DURATION_MS}
      offset={NAVBAR_CLEARANCE}
      mobileOffset={NAVBAR_CLEARANCE}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          // sonner 2.0.7 fija `z-index: 999999999` en el viewport y tapaba el
          // menú Cuenta abierto. Gana lo que el usuario abrió: menús, popovers y
          // selects (`z-[110]`) van encima; diálogos, sheets (`z-50`) y el visor a
          // pantalla completa (`z-[60]`), debajo. sonner copia este `style` inline
          // al mismo `ol`; su `--z-index` solo ordena los toasts dentro de la lista.
          zIndex: 100,
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
