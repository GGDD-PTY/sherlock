import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const readAppFile = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), 'utf8')

describe('public informational launch surfaces', () => {
  it('keeps public support and legal copy unconditional after the pivot', () => {
    // El Centro de Ayuda se fundió en /ayuda ([F] 2026-09-01): la copia vive en
    // los catálogos; el contacto va al equipo de esta instalación.
    const help = [
      readAppFile('src/app/[locale]/(public)/ayuda/page.tsx'),
      readAppFile('src/components/ayuda/HelpCenter.tsx'),
      readAppFile('src/components/ayuda/AyudaFeedback.tsx'),
    ].join('\n')
    const notFound = readAppFile('src/app/[locale]/not-found.tsx')
    const terms = readAppFile('src/app/[locale]/(public)/terms/page.tsx')
    const privacy = readAppFile('src/app/[locale]/(public)/privacy/page.tsx')

    expect(help).not.toMatch(/launch-mode|publicSiteOnly/)
    expect(help).toContain('support.sendCompanyMessage')
    expect(help).not.toContain('mailto:')
    expect(notFound).toContain('href={HELP_PATH}')
    expect(notFound).not.toContain('mailto:')
    expect(notFound).not.toMatch(/publicSiteOnly/)
    expect(notFound).toMatch(/t\('access'\)/)
    expect(terms).not.toMatch(/sociedad anónima|Panamanian company/i)
    expect(privacy).not.toMatch(/Panamanian operator of the Sherlock Platform/i)
    // [F] 2026-09-03 23:30: el sitio ships solo en español; la cláusula que
    // condiciona pagos y KYC/KYB vive en la política española.
    expect(privacy).toMatch(
      /solo si se habilitan para una oferta o flujo de verificación específico/i
    )
  })

  // El marketplace se despublica en el código, no detrás de un switch de
  // ambiente. `SHERLOCK_PUBLIC_SITE_ONLY` llegó a ser el interruptor que decidía
  // si /deals, /companies e /investors se servían; hoy el bloqueo es
  // incondicional, así que el flag quedó sin lector y se borró. Este contrato
  // impide que vuelva como bandera muerta que los validadores de prod exijan.
  it('keeps the launch-mode flag deleted instead of unread', () => {
    expect(existsSync(join(process.cwd(), 'src/lib/launch-mode.ts'))).toBe(false)

    const betaEnvCheck = readAppFile('scripts/check-beta-env.mjs')
    const prodSetup = readAppFile('scripts/validate-prod-setup.mjs')

    expect(betaEnvCheck).not.toMatch(/SHERLOCK_PUBLIC_SITE_ONLY/)
    expect(prodSetup).not.toMatch(/SHERLOCK_PUBLIC_SITE_ONLY/)
  })
})
