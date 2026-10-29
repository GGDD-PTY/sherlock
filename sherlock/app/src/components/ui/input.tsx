import * as React from 'react'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// `type` llega tipado como `HTMLInputTypeAttribute`, pero ese tipo termina en
// `| (string & {})` (`node_modules/@types/react/index.d.ts`): es la unión
// "sugerida", no una que TypeScript haga cumplir — `type="bogus"` compila
// igual que `type="email"`. El guard valida contra los 22 valores que el HTML
// realmente reconoce (mismo `.d.ts`) y no contra un subconjunto "de texto":
// `VdrUploadDialog`, `IntakeWorkspace` y `MycroftLanding` pasan `type="file"`
// por este mismo componente, así que cualquier lista más angosta que
// "texto libre" rompe la subida de documentos — el primer intento de este
// archivo lo hacía, y `VdrUploadDialog.test.tsx` lo destapó. La frontera real
// es "¿es HTML válido?", no una opinión de diseño sobre qué tipo debería
// pasar por aquí.
const HtmlInputTypeSchema = Schema.Literals([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'hidden',
  'image',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'reset',
  'search',
  'submit',
  'tel',
  'text',
  'time',
  'url',
  'week',
])
type HtmlInputType = typeof HtmlInputTypeSchema.Type
const isHtmlInputType = Schema.is(HtmlInputTypeSchema)

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  // Sin `type` se deja pasar tal cual (el navegador ya resuelve eso a texto);
  // un valor presente pero que no es HTML válido cae a 'text' en vez de
  // colarse silencioso.
  const safeType: HtmlInputType | undefined =
    type === undefined ? undefined : isHtmlInputType(type) ? type : 'text'

  return (
    <input
      type={safeType}
      data-slot="input"
      className={cn(
        'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className
      )}
      {...props}
    />
  )
}

export { Input }
