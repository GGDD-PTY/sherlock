import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { SignInLink } from '@/components/layout/SignInLink'

export function SecurityActions() {
  const t = useTranslations('settings')

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-sm">{t('accessHelp')}</p>
      {/* Misma puerta que la barra: `/sign-in` termina en WorkOS, otro origen,
          así que va por navegación de documento y no por el router. */}
      <Button variant="outline" asChild>
        <SignInLink>{t('signInLink')}</SignInLink>
      </Button>
    </div>
  )
}
