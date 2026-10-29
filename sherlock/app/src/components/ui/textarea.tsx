import * as React from 'react'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

// El HTML solo acepta 'hard' | 'soft' | 'off' para `wrap`, pero
// @types/react no tiene un `HTMLTextAreaTypeAttribute` como el de `<input>`:
// lo tipa `string | undefined` a secas (`node_modules/@types/react/index.d.ts`).
// TypeScript deja pasar `wrap="justify"` sin quejarse; el navegador
// simplemente lo ignora en silencio. El guard es la única red que existe para
// ese valor. Nadie pasa `wrap` hoy (grep sobre `<Textarea`), así que no cambia
// nada en producción.
const TextareaWrapSchema = Schema.Literals(['hard', 'soft', 'off'])
type TextareaWrap = typeof TextareaWrapSchema.Type
const isTextareaWrap = Schema.is(TextareaWrapSchema)

function Textarea({ className, wrap, ...props }: React.ComponentProps<'textarea'>) {
  const safeWrap: TextareaWrap | undefined =
    wrap === undefined ? undefined : isTextareaWrap(wrap) ? wrap : undefined

  return (
    <textarea
      data-slot="textarea"
      wrap={safeWrap}
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:bg-input/30 flex field-sizing-content min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
