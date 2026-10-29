import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')
const SOURCE_ROOT = path.join(APP_ROOT, 'src')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function walkSource(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'vdr') return []
      return walkSource(absolute)
    }
    return /\.(?:ts|tsx|css)$/.test(entry.name) ? [absolute] : []
  })
}

describe('canonical design-system contract', () => {
  it('keeps the binding non-VDR contract in docs/design-system.md', () => {
    const source = read('docs/design-system.md')
    const requiredSections = [
      '## Authority and scope',
      '## Aesthetic guard',
      '## Design tokens',
      '## Typography',
      '## Layout and responsive behavior',
      '## Component anatomy and states',
      '## Accessibility',
      '## Motion',
      '## Data visualization',
      '## Internationalization',
      '## Showcase examples',
      '## Accepted design debt',
      '## Verification',
    ]

    for (const section of requiredSections) {
      expect(source, `missing canonical section: ${section}`).toContain(section)
    }
  })

  it('traces the contract to executable tokens and the current rules page', () => {
    const source = read('docs/design-system.md')

    expect(source).toContain('sherlock/app/src/app/globals.css')
    expect(source).toContain('llm-wiki/bundle/governance/current-rules.md')
    expect(source).toContain('WCAG 2.2 AA')
    expect(source).toContain('VDR')
  })

  it('pins the six-pigment palette in both contract and executable tokens', () => {
    const contract = read('docs/design-system.md')
    const globals = read('sherlock/app/src/app/globals.css')
    const palette = {
      '--brand-burgundy': '#5a2331',
      '--brand-burgundy-deep': '#250e14',
      '--brand-ochre': '#c0873a',
      '--brand-cream': '#f6f3ec',
      '--brand-navy': '#0e1a2b',
      '--brand-grey': '#6a7689',
    } as const

    for (const [token, value] of Object.entries(palette)) {
      expect(contract.toLowerCase()).toMatch(
        new RegExp(`\\|\\s*\\\`${token}\\\`\\s*\\|\\s*\\\`${value}\\\``)
      )
      expect(globals).toContain(`${token}: ${value};`)
    }
  })

  it('ratchets known token and formatter debt instead of letting it expand', () => {
    const files = walkSource(SOURCE_ROOT)
    const source = files.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
    const count = (pattern: RegExp) => source.match(pattern)?.length ?? 0

    expect(count(/\brounded-lg\b/g)).toBeLessThanOrEqual(198)
    expect(count(/\brounded-full\b/g)).toBeLessThanOrEqual(131)
    expect(count(/\bformatCurrencyCompact\b/g)).toBeLessThanOrEqual(30)

    const shimmerFiles = files
      .filter((file) => fs.readFileSync(file, 'utf8').includes('animate-shimmer'))
      .map((file) => path.relative(SOURCE_ROOT, file))
    expect(shimmerFiles).toEqual(['app/globals.css', 'components/ui/premium-skeleton.tsx'])
  })

  it('tracks every current binding contradiction with an explicit exit', () => {
    const contract = read('docs/design-system.md')
    const trackedDebt = [
      ['D-001', '--radius'],
      ['D-002', 'Loading shimmer'],
      ['D-003', 'premium-skeleton.tsx'],
      ['D-005', '/es/sign-in'],
      ['D-006', 'src/lib/i18n/formatters.ts'],
      ['D-012', 'rounded-full'],
    ] as const

    for (const [id, anchor] of trackedDebt) {
      expect(contract).toContain(`| ${id} |`)
      expect(contract).toContain(anchor)
    }

    expect(contract).not.toContain('| D-004 |')
    expect(contract).not.toContain('| D-007 |')
    expect(contract).not.toContain('| D-009 |')
  })

  it('enforces resolved motion, close-label, chart and heading-scale obligations', () => {
    const files = walkSource(SOURCE_ROOT)
    const home = read('sherlock/app/src/components/mycroft/MycroftLanding.tsx')
    const globals = read('sherlock/app/src/app/globals.css')

    expect(home).not.toMatch(/\banimate-pulse\b/)
    expect(globals).toContain('animation: fadeInUp 0.22s ease-out forwards;')
    expect(globals).not.toContain('.animate-pulse-glow')
    expect(globals).not.toContain('.animate-marquee')
    expect(globals).not.toContain('.animate-float')
    expect(globals).not.toMatch(/color-mix\(\s*in\s+oklab/)
    expect('color-mix(\n in oklab, red 50%, blue)').toMatch(/color-mix\(\s*in\s+oklab/)

    // D-009 cerrado (DECISIONS 2026-09-03): Fraunces solo en h1/h2, escala
    // canónica 32/24, h3 en sans. Un h3 en Fraunces o un 36/30 vuelve a ser deuda.
    expect(globals).toMatch(/h1,\s*\n\s*h2\s*\{\s*\n\s*font-family: var\(--font-display\)/)
    expect(globals).not.toMatch(/h1,\s*\n\s*h2,\s*\n\s*h3\s*\{/)
    expect(globals).toContain('h1 {\n    @apply text-[2rem] leading-tight font-normal;')
    expect(globals).toContain('h2 {\n    @apply text-2xl leading-tight font-normal;')
    expect(globals).toContain('h3 {\n    @apply text-lg leading-snug font-semibold;')
    expect(globals).toContain('.eyebrow {')
    expect(globals).toContain('.rule-editorial {')
    expect(globals).toContain(
      '.scrim {\n    background: color-mix(in srgb, var(--brand-navy) 50%, transparent);'
    )
    for (const relative of [
      'components/ui/dialog.tsx',
      'components/ui/sheet.tsx',
      'components/ui/alert-dialog.tsx',
    ]) {
      const primitiveSource = fs.readFileSync(path.join(SOURCE_ROOT, relative), 'utf8')
      expect(primitiveSource).toContain('scrim')
      expect(primitiveSource).not.toContain('bg-black/50')
    }

    const hardcodedCloseFiles = files
      .filter((file) =>
        fs.readFileSync(file, 'utf8').includes('<span className="sr-only">Close</span>')
      )
      .map((file) => path.relative(SOURCE_ROOT, file))
      .sort()
    expect(hardcodedCloseFiles).toEqual([])
    for (const primitive of ['components/ui/dialog.tsx', 'components/ui/sheet.tsx']) {
      const primitiveSource = fs.readFileSync(path.join(SOURCE_ROOT, primitive), 'utf8')
      expect(primitiveSource).toContain("useTranslations('common.buttons')")
      expect(primitiveSource).toContain("{t('close')}")
      expect(primitiveSource).not.toContain('document.documentElement.lang')
    }

    const bespokeChartFiles = files
      .filter((file) => /\bbg-chart-[1-5]\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(SOURCE_ROOT, file))
      .sort()
    expect(bespokeChartFiles).toEqual([])

    for (const chartFile of bespokeChartFiles) {
      const chartSource = fs.readFileSync(path.join(SOURCE_ROOT, chartFile), 'utf8')
      expect(chartSource).toContain('motion-reduce')
      expect(chartSource).toMatch(/<table|<Table/)
      expect(chartSource).toMatch(/provenance/)
    }
  })

  it('keeps investor and marketplace shortcuts off the home surface after the pivot', () => {
    const home = read('sherlock/app/src/components/mycroft/MycroftLanding.tsx')

    expect(home).not.toMatch(/href=["'{]\s*['"]?\/(deals|companies|investors)\b/)
    expect(home).not.toContain('INVESTOR')
  })
})

describe('non-production design-system showcase contract', () => {
  it('does not expose the showcase through public metadata or navigation', () => {
    for (const relativePath of [
      'sherlock/app/src/app/sitemap.ts',
      'sherlock/app/src/app/robots.ts',
      'sherlock/app/src/components/layout/Navbar.tsx',
      'sherlock/app/src/components/layout/SiteFooter.tsx',
    ]) {
      expect(read(relativePath)).not.toContain('design-system')
    }
  })

  it('uses synthetic fixtures and all six design contract families', () => {
    const fixtures = read('sherlock/app/src/components/showcase/showcase-fixtures.ts')
    const showcaseDirectory = path.join(SOURCE_ROOT, 'components', 'showcase')
    const showcaseFiles = fs.readdirSync(showcaseDirectory)

    expect(fixtures).toContain('SYNTHETIC_SHOWCASE_FIXTURES')
    expect(fixtures).not.toMatch(/fetch\(|useQuery|Convex|@workos/)
    for (const family of ['Foundations', 'Controls', 'Feedback', 'Content', 'Data', 'Shell']) {
      expect(showcaseFiles).toContain(`${family}Showcase.tsx`)
    }
  })
})
