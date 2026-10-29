import type { ComponentProps } from 'react'
import { Schema } from 'effect'

import { cn } from '@/lib/utils'

import {
  SHERLOCK_LOCKUP_MARK_SCALE,
  SHERLOCK_LOCKUP_VIEW_BOX,
  SHERLOCK_LOCKUP_WORDMARK_OFFSET,
  SHERLOCK_MARK_PATH,
  SHERLOCK_MARK_TRANSFORM,
  SHERLOCK_WORDMARK_PATH,
  SHERLOCK_WORDMARK_TRANSFORM,
} from './brand-paths'

type SherlockLockupProps = Omit<ComponentProps<'svg'>, 'children'> & {
  // Nombre accesible cuando el lockup va solo. Dentro de un enlace que ya
  // lleva aria-label se omite y el SVG queda decorativo. El wordmark solo (sin
  // isotipo) no tiene consumidor hoy; sus trazos viven en brand-paths.ts.
  title?: string
}

const isAccessibleTitle = Schema.is(Schema.NonEmptyString)

// Lockup oficial (isotipo + wordmark), uso principal: header, firma, portadas.
// Misma composición que public/brand/sherlock-lockup.svg. Proporción 4342:934
// (4.65:1); el kit fija 120px de ancho mínimo, o sea h ≥ 26px.
export function SherlockLockup({ className, title, ...props }: SherlockLockupProps) {
  const accessibleTitle = isAccessibleTitle(title) ? title : undefined
  return (
    <svg
      viewBox={SHERLOCK_LOCKUP_VIEW_BOX}
      fill="currentColor"
      role={accessibleTitle ? 'img' : undefined}
      aria-label={accessibleTitle}
      aria-hidden={accessibleTitle ? undefined : true}
      focusable="false"
      className={cn('inline-block h-8 w-auto shrink-0', className)}
      {...props}
    >
      {accessibleTitle ? <title>{accessibleTitle}</title> : null}
      <g transform={SHERLOCK_LOCKUP_MARK_SCALE}>
        <g transform={SHERLOCK_MARK_TRANSFORM}>
          <path d={SHERLOCK_MARK_PATH} />
        </g>
      </g>
      <g transform={SHERLOCK_LOCKUP_WORDMARK_OFFSET}>
        <g transform={SHERLOCK_WORDMARK_TRANSFORM}>
          <path d={SHERLOCK_WORDMARK_PATH} />
        </g>
      </g>
    </svg>
  )
}
