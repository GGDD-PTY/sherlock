import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `variant` y `size` salen al DOM como `data-variant` / `data-size` y también
// alimentan cva. Un valor fuera del catálogo no pinta la clase ni el atributo
// que el CSS espera: se cuela silencioso. El guard cae a default.
const ButtonVariantSchema = Schema.Literals([
  'default',
  'destructive',
  'outline',
  'secondary',
  'cta',
  'cta-secondary',
  'ghost',
  'link',
  'ochre',
])
type ButtonVariant = typeof ButtonVariantSchema.Type
const isButtonVariant = Schema.is(ButtonVariantSchema)

const ButtonSizeSchema = Schema.Literals(['default', 'sm', 'lg', 'icon', 'icon-sm', 'icon-lg'])
type ButtonSize = typeof ButtonSizeSchema.Type
const isButtonSize = Schema.is(ButtonSizeSchema)
const isAsChild = Schema.is(Schema.Boolean)

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all active:translate-y-px motion-reduce:transition-none motion-reduce:active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50 dark:hover:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        /* Par de CTAs de marca — decisión dark mode 2026-07-24: en oscuro el
           accent es dorado+ink (reservado al único CTA que importa por
           pantalla); en claro resuelve a plum+marfil. */
        cta: 'bg-accent text-accent-foreground shadow-xs hover:bg-accent/90',
        'cta-secondary':
          'border border-accent/55 bg-transparent text-accent shadow-xs hover:bg-accent/10 hover:text-accent',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
        // Ocre sobre borgoña: el acento único de la landing va en el botón de
        // selección, no en una regla bajo el título ([F] 2026-09-14).
        ochre: 'bg-highlight text-[var(--brand-navy)] shadow-xs hover:bg-highlight/90',
      } satisfies Record<ButtonVariant, string>,
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        sm: 'h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      } satisfies Record<ButtonSize, string>,
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const safeVariant = isButtonVariant(variant) ? variant : 'default'
  const safeSize = isButtonSize(size) ? size : 'default'
  const safeAsChild = isAsChild(asChild) ? asChild : false
  const Comp = safeAsChild ? Slot : 'button'

  return (
    <Comp
      data-slot="button"
      data-variant={safeVariant}
      data-size={safeSize}
      className={cn(buttonVariants({ variant: safeVariant, size: safeSize, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants, ButtonVariantSchema }
