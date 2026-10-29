import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function absolute(relativePath: string): string {
  return path.join(APP_ROOT, relativePath)
}

describe('sell-side surface contract', () => {
  it('removes retired localized client route families while preserving the company/admin spine', () => {
    const forbiddenDirectories = [
      // [F] 2026-09-07 09:00: el perfil y el editor del marketplace salieron;
      // la información de la empresa vive en la sala (CompanyProfileForm).
      'src/app/[locale]/(app)/my-company/profile',
      'src/app/[locale]/(app)/my-company/edit',
      'src/app/[locale]/(app)/deals',
      'src/app/[locale]/(app)/companies',
      'src/app/[locale]/(app)/investors',
      'src/app/[locale]/(app)/connections',
      'src/app/[locale]/(app)/messages',
      'src/app/[locale]/(app)/my-investor',
      'src/app/[locale]/(app)/portfolio',
      'src/app/[locale]/(app)/checkout',
      'src/app/[locale]/(app)/my-company/deals',
      'src/app/[locale]/(app)/onboarding/investor',
      'src/app/[locale]/(app)/onboarding/kyc',
      // Rutas que solo redirigían: el destino se resuelve en el origen
      // ([F] 2026-09-07 09:00, «si la página no existe, no debería existir y
      // redirigir»).
      'src/app/[locale]/(app)/dashboard',
      'src/app/[locale]/data-room',
      // `/admin/nda` salió con el rol INVESTOR y el marketplace ([F] 2026-09-16):
      // monitoreaba los NDAs firmados por inversionistas, que ya no existen.
      'src/app/[locale]/(app)/admin/nda',
    ]

    expect(forbiddenDirectories.filter((directory) => fs.existsSync(absolute(directory)))).toEqual(
      []
    )

    const forbiddenFiles = [
      'src/app/[locale]/pricing/page.tsx',
      'src/app/[locale]/precios/page.tsx',
    ]
    expect(forbiddenFiles.filter((file) => fs.existsSync(absolute(file)))).toEqual([])

    const retainedFiles = [
      'src/app/[locale]/(public)/page.tsx',
      'src/app/[locale]/(public)/ayuda/page.tsx',
      'src/app/[locale]/(public)/sign-in/[[...sign-in]]/page.tsx',
      'src/app/[locale]/sign-up/[[...sign-up]]/page.tsx',
      'src/app/[locale]/vdr-guest/page.tsx',
      'src/app/[locale]/intake/page.tsx',
      'src/app/[locale]/(app)/my-company/documents/page.tsx',
    ]
    expect(retainedFiles.filter((file) => !fs.existsSync(absolute(file)))).toEqual([])
  })

  it('removes dormant marketplace APIs, UI exports and their Convex tables', () => {
    const companies = fs.readFileSync(absolute('convex/companies.ts'), 'utf8')
    const analytics = fs.readFileSync(absolute('convex/analytics.ts'), 'utf8')
    const skeletons = fs.readFileSync(absolute('src/components/ui/premium-skeleton.tsx'), 'utf8')

    for (const exportName of [
      'saveCompany',
      'removeSavedCompany',
      'isCompanySaved',
      'getSavedCompanies',
      'getSavedCompaniesWithDetails',
      'listPublicCompanies',
      'getFeaturedCompanies',
    ]) {
      expect(companies).not.toContain(`export const ${exportName}`)
    }
    for (const exportName of ['getAdminStats', 'getActivityTimeline', 'getConversionFunnel']) {
      expect(analytics).not.toContain(exportName)
    }
    expect(skeletons).not.toContain('InvestorFormSkeleton')
    // La custodia en el schema terminó ([F] 2026-09-16): las tablas del
    // marketplace y del rol INVESTOR se borran, no se conservan.
    const schema = fs.readFileSync(absolute('convex/schema.ts'), 'utf8')
    for (const table of [
      'investors',
      'dealInterests',
      'connections',
      'messages',
      'ndas',
      'ndaSignatures',
      'generatedNdas',
      'ndaTemplates',
      'dealMilestones',
      'messageTemplates',
      'savedDeals',
      'savedCompanies',
      'savedInvestors',
    ]) {
      expect(schema).not.toContain(`${table}: defineTable`)
    }
    expect(schema).not.toContain("'INVESTOR'")
  })
})
