import type { ReactNode } from 'react'
import { Schema } from 'effect'

// Las anclas de la vitrina son fragmentos de URL: un typo no rompe el build,
// deja un enlace interno muerto. Se decodifican al cargar el módulo.
const ShowcaseAnchorSchema = Schema.Literals(['showcase-controls', 'showcase-feedback'])
const decodeShowcaseAnchor = Schema.decodeSync(ShowcaseAnchorSchema)

export const SHOWCASE_CONTROLS_ANCHOR_ID = decodeShowcaseAnchor('showcase-controls')
export const SHOWCASE_FEEDBACK_ANCHOR_ID = decodeShowcaseAnchor('showcase-feedback')

const isShowcaseCopy = Schema.is(Schema.String)

type ShowcaseSectionProps = {
  readonly title: string
  readonly description: string
  readonly children: ReactNode
}

export function ShowcaseSection({ title, description, children }: ShowcaseSectionProps) {
  const safeTitle = isShowcaseCopy(title) ? title : ''
  const safeDescription = isShowcaseCopy(description) ? description : ''

  return (
    <section
      data-testid="showcase-family"
      className="border-border scroll-mt-8 border-t pt-8 first:border-t-0 first:pt-0"
    >
      <header className="mb-6 max-w-3xl">
        <h2 className="font-display text-foreground text-2xl font-semibold">{safeTitle}</h2>
        <p className="text-muted-foreground mt-2 text-sm leading-6">{safeDescription}</p>
      </header>
      {children}
    </section>
  )
}

type ExampleProps = {
  readonly label: string
  readonly children: ReactNode
  readonly className?: string
}

export function Example({ label, children, className = '' }: ExampleProps) {
  const safeLabel = isShowcaseCopy(label) ? label : ''
  const safeClassName = isShowcaseCopy(className) ? className : ''

  return (
    <div
      className={`border-border bg-card min-w-0 rounded-md border p-4 shadow-sm ${safeClassName}`}
    >
      <p className="text-muted-foreground mb-3 text-xs font-medium tracking-wide uppercase">
        {safeLabel}
      </p>
      {children}
    </div>
  )
}
