'use client'

import { useTranslations } from 'next-intl'
import { Schema } from 'effect'
import type { ComponentType } from 'react'

import { ContentShowcase } from './ContentShowcase'
import { ControlsShowcase } from './ControlsShowcase'
import { DataShowcase } from './DataShowcase'
import { FeedbackShowcase } from './FeedbackShowcase'
import { FoundationsShowcase } from './FoundationsShowcase'
import { RouteStateShowcase } from './RouteStateShowcase'
import { ShellShowcase } from './ShellShowcase'

const ShowcaseFamilySchema = Schema.Literals([
  'foundations',
  'controls',
  'feedback',
  'content',
  'data',
  'shell',
  'route-state',
])
type ShowcaseFamily = typeof ShowcaseFamilySchema.Type

const SHOWCASE_FAMILY_COMPONENT = {
  foundations: FoundationsShowcase,
  controls: ControlsShowcase,
  feedback: FeedbackShowcase,
  content: ContentShowcase,
  data: DataShowcase,
  shell: ShellShowcase,
  'route-state': RouteStateShowcase,
} satisfies Record<ShowcaseFamily, ComponentType>

export function PrimitiveShowcase() {
  const t = useTranslations('designSystem')

  return (
    <div className="bg-background text-foreground min-h-[100dvh]">
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <header className="border-border mb-10 border-b pb-8">
          <p className="text-primary text-xs font-semibold tracking-wide uppercase">
            {t('eyebrow')}
          </p>
          <h1 className="font-display mt-3 text-4xl">{t('title')}</h1>
          <p className="text-muted-foreground mt-4 max-w-3xl leading-7">{t('description')}</p>
          <p className="border-warning/50 bg-muted text-foreground mt-4 inline-flex rounded-sm border px-3 py-2 text-xs">
            {t('nonProduction')}
          </p>
        </header>
        <div className="space-y-12">
          {ShowcaseFamilySchema.literals.map((family) => {
            const Family = SHOWCASE_FAMILY_COMPONENT[family]
            return <Family key={family} />
          })}
        </div>
      </div>
    </div>
  )
}
