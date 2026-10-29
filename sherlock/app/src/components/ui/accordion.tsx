'use client'

import * as React from 'react'
import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { Schema } from 'effect'
import { ChevronDownIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// `type` discrimina single vs multiple en Radix. Un string que no es del
// catálogo deja el acordeón en un estado que el primitive no documenta.
// El guard cae a single.
const AccordionTypeSchema = Schema.Literals(['single', 'multiple'])
type AccordionType = typeof AccordionTypeSchema.Type
const isAccordionType = Schema.is(AccordionTypeSchema)

const AccordionDirSchema = Schema.Literals(['ltr', 'rtl'])
type AccordionDir = typeof AccordionDirSchema.Type
const isAccordionDir = Schema.is(AccordionDirSchema)

function Accordion(props: React.ComponentProps<typeof AccordionPrimitive.Root>) {
  const type: AccordionType = isAccordionType(props.type) ? props.type : 'single'
  const dir: AccordionDir | undefined =
    props.dir === undefined ? undefined : isAccordionDir(props.dir) ? props.dir : undefined

  if (props.type === 'multiple') {
    return <AccordionPrimitive.Root data-slot="accordion" {...props} dir={dir} />
  }

  return (
    <AccordionPrimitive.Root
      data-slot="accordion"
      {...props}
      type={type === 'multiple' ? 'single' : type}
      dir={dir}
    />
  )
}

function AccordionItem({
  className,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Item>) {
  return (
    <AccordionPrimitive.Item
      data-slot="accordion-item"
      className={cn('border-b last:border-b-0', className)}
      {...props}
    />
  )
}

function AccordionTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Trigger>) {
  return (
    <AccordionPrimitive.Header className="flex">
      <AccordionPrimitive.Trigger
        data-slot="accordion-trigger"
        className={cn(
          'focus-visible:border-ring focus-visible:ring-ring/50 flex flex-1 items-start justify-between gap-4 rounded-md py-4 text-left text-sm font-medium transition-all outline-none hover:underline focus-visible:ring-[3px] disabled:pointer-events-none disabled:opacity-50 [&[data-state=open]>svg]:rotate-180',
          className
        )}
        {...props}
      >
        {children}
        <ChevronDownIcon className="text-muted-foreground pointer-events-none size-4 shrink-0 translate-y-0.5 transition-transform duration-200" />
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  )
}

function AccordionContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof AccordionPrimitive.Content>) {
  return (
    <AccordionPrimitive.Content
      data-slot="accordion-content"
      className="data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down overflow-hidden text-sm"
      {...props}
    >
      <div className={cn('pt-0 pb-4', className)}>{children}</div>
    </AccordionPrimitive.Content>
  )
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent }
