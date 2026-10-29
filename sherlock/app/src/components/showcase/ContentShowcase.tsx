import { useTranslations } from 'next-intl'
import { Schema } from 'effect'
import { Building2, MapPin } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SYNTHETIC_SHOWCASE_FIXTURES } from './showcase-fixtures'
import { Example, ShowcaseSection } from './ShowcaseSection'

const SyntheticIdSchema = Schema.String.pipe(Schema.check(Schema.isPattern(/^SYN-/)))
const isSyntheticId = Schema.is(SyntheticIdSchema)

export function ContentShowcase() {
  const t = useTranslations('designSystem')
  const { company, mandate, invalidReference } = SYNTHETIC_SHOWCASE_FIXTURES
  const companyId = isSyntheticId(company.id) ? company.id : invalidReference
  const mandateId = isSyntheticId(mandate.id) ? mandate.id : invalidReference

  return (
    <ShowcaseSection title={t('families.content')} description={t('descriptions.content')}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Example label={t('examples.editorial')}>
          <article className="max-w-prose">
            <p className="text-primary mb-2 text-xs font-semibold tracking-wide uppercase">
              {t('content.eyebrow')}
            </p>
            <h3 className="text-foreground text-3xl">{t('content.editorialTitle')}</h3>
            <p className="text-muted-foreground mt-3 leading-7">{t('content.body')}</p>
          </article>
        </Example>
        <Example label={t('examples.teaser')}>
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle>{t('content.mandateTitle')}</CardTitle>
                  <CardDescription className="mt-2 font-mono text-xs">{mandateId}</CardDescription>
                </div>
                <Badge variant="outline">{t('content.synthetic')}</Badge>
              </div>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground text-sm">{t('content.teaserBody')}</p>
            </CardContent>
          </Card>
        </Example>
        <Example label={t('examples.companyCard')}>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="bg-muted flex size-10 items-center justify-center rounded-md">
                  <Building2 aria-hidden="true" className="size-5" />
                </div>
                <div>
                  <CardTitle>{t('content.companyExample')}</CardTitle>
                  <CardDescription className="font-mono text-xs">{companyId}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex items-center gap-2 text-sm">
              <MapPin className="size-4" aria-hidden="true" />
              {t('content.location')}
            </CardContent>
          </Card>
        </Example>
        <Example label={t('examples.legal')}>
          <div className="max-w-prose space-y-3 text-sm leading-6">
            <h3 className="font-semibold">{t('content.legalTitle')}</h3>
            <p>{t('content.legalBody')}</p>
          </div>
        </Example>
      </div>
    </ShowcaseSection>
  )
}
