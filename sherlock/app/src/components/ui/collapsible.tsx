'use client'

import * as React from 'react'
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { Schema } from 'effect'

// `open` / `defaultOpen` / `disabled` se deciden con `Schema.is(Schema.Boolean)`,
// no con la coerción de JS. Un truthy que no es booleano (`'yes'`, 1) cae al
// default no controlado en vez de colarse como "abierto".
const isBooleanProp = Schema.is(Schema.Boolean)

function toOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  return isBooleanProp(value) ? value : undefined
}

// Los tres envoltorios existen para colgar `data-slot`. En React 19 `ref` es
// una prop más, así que el spread la reenvía a Radix sin `forwardRef`.
function Collapsible({
  open,
  defaultOpen,
  disabled,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return (
    <CollapsiblePrimitive.Root
      data-slot="collapsible"
      open={toOptionalBoolean(open)}
      defaultOpen={toOptionalBoolean(defaultOpen)}
      disabled={toOptionalBoolean(disabled)}
      {...props}
    />
  )
}

function CollapsibleTrigger(
  props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>
) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />
}

function CollapsibleContent(
  props: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>
) {
  return <CollapsiblePrimitive.CollapsibleContent data-slot="collapsible-content" {...props} />
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
