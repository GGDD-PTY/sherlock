'use client'

import * as React from 'react'
import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// El CSS de padding y eje (`h-full w-2.5` vs `h-2.5 flex-col`) solo corre
// cuando `orientation` es del catálogo. Cualquier otro string deja la barra
// sin tamaño. El guard restaura `vertical`.
const ScrollBarOrientationSchema = Schema.Literals(['vertical', 'horizontal'])
type ScrollBarOrientation = typeof ScrollBarOrientationSchema.Type
const isScrollBarOrientation = Schema.is(ScrollBarOrientationSchema)

// Ref al viewport para scroll programático (chats). En React 19
// `Ref<HTMLDivElement>` ya admite `RefObject<HTMLDivElement | null>` y
// `undefined` cuando nadie la pasa, así que viaja sin casteo.
interface ScrollAreaProps extends React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> {
  viewportRef?: React.RefObject<HTMLDivElement | null>
}

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(({ className, children, viewportRef, ...props }, ref) => (
  <ScrollAreaPrimitive.Root
    ref={ref}
    className={cn('relative overflow-hidden', className)}
    {...props}
  >
    <ScrollAreaPrimitive.Viewport ref={viewportRef} className="h-full w-full rounded-[inherit]">
      {children}
    </ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
))
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => {
  const safeOrientation: ScrollBarOrientation = isScrollBarOrientation(orientation)
    ? orientation
    : 'vertical'

  return (
    <ScrollAreaPrimitive.ScrollAreaScrollbar
      ref={ref}
      orientation={safeOrientation}
      className={cn(
        'flex touch-none transition-colors select-none',
        safeOrientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
        safeOrientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
        className
      )}
      {...props}
    >
      <ScrollAreaPrimitive.ScrollAreaThumb className="bg-border relative flex-1 rounded-full" />
    </ScrollAreaPrimitive.ScrollAreaScrollbar>
  )
})
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName

export { ScrollArea }
