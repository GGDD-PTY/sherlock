import { Effect } from 'effect'

import type { Doc, Id } from '@/../convex/_generated/dataModel'
import { isValidCountry, type CountryCode } from '@/lib/constants/countries'
import { isValidCurrency, type CurrencyCode } from '@/lib/constants/currencies'

// `Doc<'companies'>` declara `country` y `currency` como `string`, así que
// estas seis filas podían nombrar un país o una moneda que el catálogo ya no
// tiene y la sala las pintaba con el value crudo —`getCountryLabel` devuelve la
// cadena tal cual—. Pinnearlas a su catálogo hace que renombrar cualquiera de
// los dos rompa la compilación acá. `sector` e `industry` son texto libre
// ([F] 2026-09-17): no hay catálogo contra el cual pinnearlos.
type DemoCompany = Doc<'companies'> & {
  employees?: string
  isVerified?: boolean
  country: CountryCode
  currency: CurrencyCode
}

export const DEMO_COMPANY_PROFILE_ID = 'demo_company_profile' as Id<'profiles'>

export const DEMO_PUBLIC_COMPANIES: DemoCompany[] = [
  {
    _id: 'demo_company_001' as Id<'companies'>,
    _creationTime: 1_700_000_000_000,
    ownerId: DEMO_COMPANY_PROFILE_ID,
    name: 'Sample Hydro, S. A.',
    legalName: 'Sample Hydro, S. A.',
    logoUrl: undefined,
    website: undefined,
    tagline: 'Empresa hidroeléctrica ficticia de 24 MW para pruebas del Data Room.',
    country: 'PA',
    city: 'Panama City',
    industry: 'renewable_utilities',
    sector: 'utilities',
    businessModel: 'B2B',
    stage: 'MATURE',
    foundedYear: 2020,
    revenueRange: '$10M-$25M',
    revenueCurrent: 12_000_000,
    ebitdaMargin: 50,
    totalLiabilities: 8_000_000,
    currency: 'USD',
    foundersDescription: 'Perfil ficticio creado exclusivamente para pruebas del producto.',
    onboardingStep: 6,
    onboardingCompletedAt: 1_700_000_000_000,
    isVerified: true,
    isFeatured: false,
    isPublic: true,
    description:
      'Sample Hydro es una empresa ficticia. Sus activos, contrapartes y cifras se inventaron para probar el Data Room.',
    mission: 'Operar activos hidroeléctricos con disciplina financiera y trazabilidad documental.',
    managementTeam: [
      {
        name: 'Equipo ejecutivo de SAMPLE_HYDRO',
        title: 'Management',
        bio: 'Equipo demostrativo para el recorrido de preparación y data room.',
      },
    ],
  },
  {
    _id: 'demo_company_002' as Id<'companies'>,
    _creationTime: 1_700_100_000_000,
    ownerId: 'demo_company_profile_002' as Id<'profiles'>,
    name: 'AgroFinance Demo',
    legalName: 'AgroFinance Demo S.A.',
    logoUrl: undefined,
    website: 'https://agrofinance.local',
    tagline: 'Embedded credit for agricultural suppliers',
    country: 'CO',
    city: 'Bogota',
    industry: 'food_beverage',
    sector: 'consumer_defensive',
    businessModel: 'FINTECH',
    stage: 'SERIES_A',
    foundedYear: 2021,
    employeesCount: 28,
    revenueRange: '$500K-$1M',
    revenueCurrent: 850_000,
    revenueGrowthYoy: 0.22,
    grossMargin: 0.48,
    ebitdaMargin: 0.12,
    netMargin: 0.05,
    currency: 'USD',
    seekingAmount: 1_000_000,
    seekingType: 'DEBT',
    fundraisingTimeline: '12_MONTHS',
    useOfFunds: 'Receivables financing and regional distribution partnerships.',
    foundersDescription: 'Agriculture and credit team with regional distribution experience.',
    teamSize: '10-30',
    companyLinkedin: 'https://linkedin.com/company/agrofinance-demo',
    onboardingStep: 5,
    onboardingCompletedAt: 1_700_100_000_000,
    isVerified: true,
    isFeatured: false,
    isPublic: true,
    description: 'Demo agricultural finance company for public directory testing.',
    mission: 'Finance productive inputs for small and mid-sized agricultural producers.',
    managementTeam: [],
  },
  {
    _id: 'demo_company_003' as Id<'companies'>,
    _creationTime: 1_700_200_000_000,
    ownerId: 'demo_company_profile_003' as Id<'profiles'>,
    name: 'Pacific Cold Chain Demo',
    legalName: 'Pacific Cold Chain Demo S.A.',
    logoUrl: undefined,
    website: 'https://pacificcoldchain.local',
    tagline: 'Temperature-controlled logistics for food exporters across the Pacific corridor',
    country: 'PE',
    city: 'Lima',
    industry: 'logistics',
    sector: 'industrials',
    businessModel: 'SERVICES',
    stage: 'GROWTH',
    foundedYear: 2018,
    employeesCount: 86,
    revenueRange: '$5M-$10M',
    revenueCurrent: 6_800_000,
    revenueGrowthYoy: 0.29,
    grossMargin: 0.41,
    ebitdaMargin: 0.16,
    netMargin: 0.07,
    currency: 'USD',
    seekingAmount: 4_000_000,
    seekingType: 'DEBT',
    fundraisingTimeline: '6_MONTHS',
    useOfFunds: 'Warehouse expansion, refrigerated fleet financing, and exporter onboarding.',
    foundersDescription: 'Cold-chain operators with regional logistics and food-export experience.',
    teamSize: '50-100',
    companyLinkedin: 'https://linkedin.com/company/pacific-cold-chain-demo',
    onboardingStep: 5,
    onboardingCompletedAt: 1_700_200_000_000,
    isVerified: true,
    isFeatured: true,
    isPublic: true,
    description:
      'Regional cold-chain operator serving seafood, fruit, and specialty-food exporters with contracted routes and recurring storage revenue.',
    mission: 'Reduce spoilage and improve export reliability for mid-market LATAM producers.',
    managementTeam: [],
  },
  {
    _id: 'demo_company_004' as Id<'companies'>,
    _creationTime: 1_700_300_000_000,
    ownerId: 'demo_company_profile_004' as Id<'profiles'>,
    name: 'Cobre Solar Partners Demo',
    legalName: 'Cobre Solar Partners Demo SpA',
    logoUrl: undefined,
    website: 'https://cobresolar.local',
    tagline: 'Distributed solar and storage for mining-adjacent industrial customers',
    country: 'CL',
    city: 'Santiago',
    industry: 'renewable_energy',
    sector: 'energy',
    businessModel: 'SERVICES',
    stage: 'MATURE',
    foundedYear: 2016,
    employeesCount: 58,
    revenueRange: '$10M-$25M',
    revenueCurrent: 14_200_000,
    revenueGrowthYoy: 0.18,
    grossMargin: 0.38,
    ebitdaMargin: 0.21,
    netMargin: 0.09,
    currency: 'USD',
    seekingAmount: 7_500_000,
    seekingType: 'BRIDGE',
    fundraisingTimeline: '3_MONTHS',
    useOfFunds: 'Project bridge capital for contracted solar installations and battery systems.',
    foundersDescription:
      'Energy infrastructure team with mining-sector project finance experience.',
    teamSize: '50-100',
    companyLinkedin: 'https://linkedin.com/company/cobre-solar-demo',
    onboardingStep: 5,
    onboardingCompletedAt: 1_700_300_000_000,
    isVerified: true,
    isFeatured: false,
    isPublic: true,
    description:
      'Energy-services company with signed offtake contracts and a pipeline of distributed solar projects for industrial customers.',
    mission:
      'Provide reliable, lower-cost power to industrial operators in resource-heavy regions.',
    managementTeam: [],
  },
  {
    _id: 'demo_company_005' as Id<'companies'>,
    _creationTime: 1_700_400_000_000,
    ownerId: 'demo_company_profile_005' as Id<'profiles'>,
    name: 'Isthmus SaaS Operations Demo',
    legalName: 'Isthmus SaaS Operations Demo Inc.',
    logoUrl: undefined,
    website: 'https://isthmussaas.local',
    tagline: 'Workflow software for customs brokers and trade operators in Central America',
    country: 'PA',
    city: 'Panama City',
    industry: 'saas',
    sector: 'technology',
    businessModel: 'SAAS',
    stage: 'SERIES_A',
    foundedYear: 2022,
    employeesCount: 34,
    revenueRange: '$1M-$5M',
    revenueCurrent: 1_900_000,
    revenueGrowthYoy: 0.72,
    grossMargin: 0.81,
    ebitdaMargin: 0.06,
    netMargin: 0.01,
    currency: 'USD',
    seekingAmount: 3_000_000,
    seekingType: 'EQUITY',
    fundraisingTimeline: '6_MONTHS',
    useOfFunds: 'Enterprise sales, product integrations, and regional customer success.',
    foundersDescription:
      'Former trade operators and software builders focused on regulated workflows.',
    teamSize: '25-50',
    companyLinkedin: 'https://linkedin.com/company/isthmus-saas-demo',
    onboardingStep: 5,
    onboardingCompletedAt: 1_700_400_000_000,
    isVerified: true,
    isFeatured: true,
    isPublic: true,
    description:
      'Vertical SaaS platform digitizing customs documentation, approvals, and trade finance coordination for logistics-heavy customers.',
    mission: 'Make cross-border trade operations faster, auditable, and easier to finance.',
    managementTeam: [],
  },
  {
    _id: 'demo_company_006' as Id<'companies'>,
    _creationTime: 1_700_500_000_000,
    ownerId: 'demo_company_profile_006' as Id<'profiles'>,
    name: 'Río Plata Manufacturing Demo',
    legalName: 'Río Plata Manufacturing Demo S.A.',
    logoUrl: undefined,
    website: 'https://rioplatamanufacturing.local',
    tagline: 'Specialty packaging manufacturer serving regional food and consumer brands',
    country: 'AR',
    city: 'Buenos Aires',
    industry: 'manufacturing',
    sector: 'industrials',
    businessModel: 'MANUFACTURING',
    stage: 'MATURE',
    foundedYear: 2013,
    employeesCount: 124,
    revenueRange: '$10M-$25M',
    revenueCurrent: 18_600_000,
    revenueGrowthYoy: 0.14,
    grossMargin: 0.33,
    ebitdaMargin: 0.15,
    netMargin: 0.06,
    currency: 'USD',
    seekingAmount: 6_000_000,
    seekingType: 'BOTH',
    fundraisingTimeline: '12_MONTHS',
    useOfFunds: 'Equipment modernization, working capital, and regional customer expansion.',
    foundersDescription: 'Second-generation operators with long-standing customer contracts.',
    teamSize: '100-250',
    companyLinkedin: 'https://linkedin.com/company/rio-plata-manufacturing-demo',
    onboardingStep: 5,
    onboardingCompletedAt: 1_700_500_000_000,
    isVerified: true,
    isFeatured: false,
    isPublic: true,
    description:
      'Profitable specialty-packaging manufacturer with repeat customers, export potential, and equipment-led margin upside.',
    mission: 'Support regional consumer brands with reliable, financeable packaging capacity.',
    managementTeam: [],
  },
]

// ===== INTEGRIDAD DEL FIXTURE =====
// El comentario de arriba de `DemoCompany` pinnea `country`/`currency` al
// catálogo en el tipo — eso protege contra un rename en `constants/`. No
// protege contra que alguien reescriba una fila entera con un objeto literal
// donde TypeScript infiere el tipo ancho antes de que el `: DemoCompany[]` de
// arriba lo angoste. Esta comprobación corre una vez, al importar el módulo, y
// si una fila se desalinea revienta con el nombre de la empresa y el campo
// exacto, no con un texto crudo en la sala pública tres pantallas después.
Effect.runSync(
  Effect.sync(() => {
    for (const company of DEMO_PUBLIC_COMPANIES) {
      if (!isValidCountry(company.country)) {
        throw new Error(
          `demo-data: país fuera de catálogo en "${company.name}": ${company.country}`
        )
      }
      if (!isValidCurrency(company.currency)) {
        throw new Error(
          `demo-data: moneda fuera de catálogo en "${company.name}": ${company.currency}`
        )
      }
    }
  }).pipe(Effect.withSpan('DemoData.assertCatalogIntegrity'))
)
