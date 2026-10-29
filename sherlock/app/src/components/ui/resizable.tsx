'use client'

import { GripVertical } from 'lucide-react'
import * as React from 'react'
import * as ResizablePrimitive from 'react-resizable-panels'
import { Effect, Schema } from 'effect'

import { cn } from '@/lib/utils'
import { runClientSync } from '@/lib/effect/client-runtime'

// El `?.` original tragaba en silencio el caso en que el grupo todavía no
// está en el DOM (id recién generado, nodo desmontado entre el commit y el
// efecto). Nombrar el fallo no cambia el comportamiento en producción — sigue
// sin lanzar — pero deja de ser invisible: un fallo real ahora se ve en la
// consola en vez de desaparecer detrás del `?.`.
class ResizableGroupNotFoundError extends Schema.TaggedError<ResizableGroupNotFoundError>()(
  'ResizableGroupNotFoundError',
  { groupId: Schema.String }
) {}

const clearGroupAriaOrientation = Effect.fn('ResizablePanelGroup.clearAriaOrientation')(function* (
  groupId: string
) {
  const element = document.getElementById(groupId)
  if (element === null) {
    return yield* Effect.fail(new ResizableGroupNotFoundError({ groupId }))
  }
  element.removeAttribute('aria-orientation')
})

function ResizablePanelGroup({ className, orientation, ...props }: ResizablePrimitive.GroupProps) {
  const autoId = React.useId()
  const groupId = props.id ?? autoId
  // react-resizable-panels escribe aria-orientation en este div genérico, donde
  // ARIA no permite el atributo (axe aria-allowed-attr, crítico); el grupo no es
  // un widget y la semántica de orientación ya vive en el separator. El
  // primitive no expone ref, así que se localiza por id tras cada commit.
  React.useLayoutEffect(() => {
    runClientSync(
      clearGroupAriaOrientation(groupId).pipe(
        Effect.catchTag('ResizableGroupNotFoundError', (error) =>
          process.env.NODE_ENV !== 'production'
            ? Effect.logWarning('[resizable] no se encontró el grupo en el DOM', error)
            : Effect.void
        )
      )
    )
  })
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      orientation={orientation}
      className={cn('flex h-full w-full', orientation === 'vertical' && 'flex-col', className)}
      {...props}
      id={groupId}
    />
  )
}

function ResizablePanel(props: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & { withHandle?: boolean }) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        'bg-border focus-visible:ring-ring relative flex w-px items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90',
        className
      )}
      {...props}
    >
      {withHandle ? (
        <div className="bg-border z-10 flex h-6 w-3 items-center justify-center rounded-xs border">
          <GripVertical className="size-2.5" aria-hidden="true" />
        </div>
      ) : null}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
