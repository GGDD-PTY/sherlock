import { useLocale, useTranslations } from 'next-intl'
import { Schema } from 'effect'

import { formatMoney } from '@/lib/i18n/formatters'
import { SYNTHETIC_SHOWCASE_FIXTURES } from './showcase-fixtures'
import { Example, ShowcaseSection } from './ShowcaseSection'

const PaletteTokenSchema = Schema.Literals([
  'primary',
  'accent',
  'success',
  'warning',
  'destructive',
  'muted',
])
type PaletteToken = typeof PaletteTokenSchema.Type

const PALETTE_CLASSES = {
  primary: 'bg-primary text-primary-foreground',
  accent: 'bg-accent text-accent-foreground',
  success: 'bg-success text-success-foreground',
  warning: 'bg-warning text-warning-foreground',
  destructive: 'bg-destructive text-destructive-foreground',
  muted: 'bg-muted text-muted-foreground',
} satisfies Record<PaletteToken, string>

const SpacingSizeSchema = Schema.Literals([4, 8, 16, 24, 32])

export function FoundationsShowcase() {
  const t = useTranslations('designSystem')
  const locale = useLocale()
  const formattedAmount = formatMoney(SYNTHETIC_SHOWCASE_FIXTURES.mandate.amount, {
    currency: SYNTHETIC_SHOWCASE_FIXTURES.mandate.currency,
    locale,
  })

  return (
    <ShowcaseSection title={t('families.foundations')} description={t('descriptions.foundations')}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Example label={t('examples.palette')}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PaletteTokenSchema.literals.map((name) => (
              <div
                key={name}
                className={`${PALETTE_CLASSES[name]} rounded-md border p-3 text-xs font-medium`}
              >
                {t(`tokens.${name}`)}
              </div>
            ))}
          </div>
        </Example>
        <Example label={t('examples.typography')}>
          <div className="space-y-3">
            <p className="font-display text-3xl">{t('content.editorialTitle')}</p>
            <p className="text-sm">{t('content.body')}</p>
            <p className="text-sm tabular-nums">
              <span className="font-mono">{SYNTHETIC_SHOWCASE_FIXTURES.mandate.id}</span>
              {' · '}
              <span className="font-figure">{formattedAmount}</span>
            </p>
          </div>
        </Example>
        <Example label={t('examples.spacing')}>
          <div className="flex items-end gap-3" aria-label={t('examples.spacing')}>
            {SpacingSizeSchema.literals.map((size) => (
              <div key={size} className="text-center">
                <div
                  className="bg-primary mx-auto rounded-sm"
                  style={{ width: size, height: size }}
                />
                <span className="text-muted-foreground mt-1 block text-xs">{size}</span>
              </div>
            ))}
          </div>
        </Example>
        <Example label={t('examples.surfaces')}>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-background rounded-sm border p-4">{t('tokens.light')}</div>
            <div className="bg-primary text-primary-foreground rounded-md p-4 shadow-sm">
              {t('tokens.dark')}
            </div>
          </div>
        </Example>
      </div>
    </ShowcaseSection>
  )
}
