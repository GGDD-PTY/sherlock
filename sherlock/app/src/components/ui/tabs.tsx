'use client'

import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `orientation` manda el teclado (flechas horizontales vs verticales) y
// `activationMode` decide si el foco cambia de tab. Un string que no es del
// catálogo deja el widget en un estado que Radix no documenta. El guard
// restaura los defaults de la primitiva.
const TabsOrientationSchema = Schema.Literals(['horizontal', 'vertical'])
type TabsOrientation = typeof TabsOrientationSchema.Type
const isTabsOrientation = Schema.is(TabsOrientationSchema)

const TabsActivationModeSchema = Schema.Literals(['automatic', 'manual'])
type TabsActivationMode = typeof TabsActivationModeSchema.Type
const isTabsActivationMode = Schema.is(TabsActivationModeSchema)

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ orientation, activationMode, ...props }, ref) => {
  const safeOrientation: TabsOrientation | undefined =
    orientation === undefined
      ? undefined
      : isTabsOrientation(orientation)
        ? orientation
        : 'horizontal'
  const safeActivationMode: TabsActivationMode | undefined =
    activationMode === undefined
      ? undefined
      : isTabsActivationMode(activationMode)
        ? activationMode
        : 'automatic'

  return (
    <TabsPrimitive.Root
      ref={ref}
      orientation={safeOrientation}
      activationMode={safeActivationMode}
      {...props}
    />
  )
})
Tabs.displayName = TabsPrimitive.Root.displayName

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      'bg-muted text-muted-foreground inline-flex h-10 items-center justify-center rounded-md p-1',
      className
    )}
    {...props}
  />
))
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      'ring-offset-background focus-visible:ring-ring data-[state=active]:bg-primary data-[state=active]:text-primary-foreground inline-flex items-center justify-center rounded-sm px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:shadow-sm',
      className
    )}
    {...props}
  />
))
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'ring-offset-background focus-visible:ring-ring mt-2 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
