import { useTranslations } from 'next-intl'
import { Schema } from 'effect'
import { Menu, MessageSquareText, ShieldCheck } from 'lucide-react'

import { SherlockLockup } from '@/components/shared/SherlockLockup'
import { Button } from '@/components/ui/button'
import { SITE_BRAND_NAME } from '@/lib/site/brand'
import { Example, ShowcaseSection } from './ShowcaseSection'

// Los destinos de la barra autenticada, definidos una vez: cada uno es a la
// vez el `key`, la clave de traducción y el que decide qué botón va activo.
const AuthNavItemSchema = Schema.Literals(['overview', 'documents', 'messages'])
type AuthNavItem = typeof AuthNavItemSchema.Type
const ACTIVE_AUTH_NAV_ITEM: AuthNavItem = 'overview'

export function ShellShowcase() {
  const t = useTranslations('designSystem')

  return (
    <ShowcaseSection title={t('families.shell')} description={t('descriptions.shell')}>
      <div className="grid gap-4 lg:grid-cols-2">
        <Example label={t('shell.publicNav')}>
          <nav
            aria-label={t('shell.publicNav')}
            className="flex flex-wrap items-center justify-between gap-4"
          >
            <SherlockLockup
              title={SITE_BRAND_NAME}
              className="text-primary dark:text-foreground h-6"
            />
            <div className="flex w-full flex-wrap items-center justify-end gap-3 text-sm sm:w-auto">
              <a href="#showcase-feedback">{t('shell.home')}</a>
              <Button size="sm" asChild>
                <a href="#showcase-controls">{t('shell.signIn')}</a>
              </Button>
            </div>
          </nav>
        </Example>
        <Example label={t('shell.authNav')}>
          <nav aria-label={t('shell.authNav')} className="flex flex-wrap items-center gap-2">
            {AuthNavItemSchema.literals.map((item) => (
              <Button
                key={item}
                size="sm"
                variant={item === ACTIVE_AUTH_NAV_ITEM ? 'secondary' : 'ghost'}
                asChild
              >
                <a href="#showcase-feedback">{t(`shell.${item}`)}</a>
              </Button>
            ))}
          </nav>
        </Example>
        <Example label={t('shell.adminNav')}>
          <Button
            variant="outline"
            className="h-auto min-h-9 w-full justify-start text-left whitespace-normal"
            disabled
          >
            <Menu aria-hidden="true" />
            {t('shell.adminMenu')}
          </Button>
          <div className="mt-3 flex items-center gap-2 text-sm">
            <ShieldCheck className="text-success size-4" aria-hidden="true" />
            {t('shell.humanReview')}
          </div>
        </Example>
        <Example label={t('shell.messaging')}>
          <div className="border-border rounded-md border">
            <div className="border-border flex items-center gap-2 border-b p-3">
              <MessageSquareText className="size-4" aria-hidden="true" />
              <span className="font-medium">{t('shell.conversation')}</span>
            </div>
            <p className="text-muted-foreground p-4 text-sm">{t('shell.messageBody')}</p>
          </div>
        </Example>
      </div>
    </ShowcaseSection>
  )
}
