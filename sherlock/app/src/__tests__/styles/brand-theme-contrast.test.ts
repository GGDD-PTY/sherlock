import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

type Rgb = { r: number; g: number; b: number; a: number }

const TRANSPARENT: Rgb = { r: 0, g: 0, b: 0, a: 0 }

function parseHex(hex: string): Rgb {
  const normalized = hex.replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Expected a 6-digit hex, got "${hex}"`)
  }
  const value = Number.parseInt(normalized, 16)

  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a: 1 }
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`
}

/**
 * `over` is the only way an alpha token becomes a contrast number: the dark
 * borders are `cream N% / transparent`, so their real luminance depends on the
 * surface underneath.
 */
function over(top: Rgb, bottom: Rgb): Rgb {
  if (top.a >= 1) return top
  const a = top.a
  return {
    r: top.r * a + bottom.r * (1 - a),
    g: top.g * a + bottom.g * (1 - a),
    b: top.b * a + bottom.b * (1 - a),
    a: 1,
  }
}

function channelLuminance(channel: number) {
  const normalized = channel / 255
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4)
}

function relativeLuminance({ r, g, b }: Rgb) {
  return 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
}

function contrastRatio(foreground: Rgb, background: Rgb) {
  const fg = relativeLuminance(over(foreground, background))
  const bg = relativeLuminance(background)
  const lighter = Math.max(fg, bg)
  const darker = Math.min(fg, bg)

  return (lighter + 0.05) / (darker + 0.05)
}

function extractBlock(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*{([\\s\\S]*?)\\n}`))
  const body = match?.[1]
  if (!body) throw new Error(`Missing theme block: ${selector}`)

  return Object.fromEntries(
    [...body.matchAll(/^\s*(--[\w-]+):\s*([^;]+);/gm)].map((entry) => [
      entry[1],
      entry[2].trim().replace(/\s+/g, ' '),
    ])
  )
}

/**
 * The only hex literals the system may contain: the six pigments, plus the
 * three exceptions the contract declares (an error red the brand doc does not
 * define, and the white sheet a document viewer paints behind a PDF).
 */
const ALLOWED_HEXES = new Set([
  '#5a2331',
  '#250e14',
  '#c0873a',
  '#f6f3ec',
  '#0e1a2b',
  '#6a7689',
  '#8f4d3f', // --status-danger
  '#ffffff', // --paper
])

/**
 * Resolves the token layers the brand system is built from: a `var()` chain
 * down to one of the six pigments, or a `color-mix(in srgb, A p%, B)` of them.
 * Anything else is a hex. If this throws, a token stopped being derivable from
 * the pigments, which is exactly the regression the system exists to prevent.
 */
function resolve(token: string, vars: Record<string, string>, seen = new Set<string>()): Rgb {
  if (seen.has(token)) throw new Error(`Circular token reference: ${token}`)
  seen.add(token)

  const raw = token.startsWith('--') ? vars[token] : token
  if (!raw) throw new Error(`Undefined token: ${token}`)

  if (raw === 'transparent') return TRANSPARENT
  if (raw.startsWith('#')) {
    // The whole system is "one hex per colour". A raw hex is only legal if it
    // is a pigment or one of the three declared exceptions; anything else is a
    // seventh colour entering through the back door, and resolving it silently
    // is what let the previous version of this test pass while proving nothing.
    if (!ALLOWED_HEXES.has(raw.toLowerCase())) {
      throw new Error(`Token "${token}" introduces a non-pigment hex: ${raw}`)
    }
    return parseHex(raw)
  }

  const variable = raw.match(/^var\((--[\w-]+)\)$/)?.[1]
  if (variable) return resolve(variable, vars, seen)

  const mix = raw.match(/^color-mix\(in srgb,\s*(.+?)\s+(\d+)%,\s*(.+?)\)$/)
  if (mix) {
    const first = resolve(mix[1].replace(/^var\((--[\w-]+)\)$/, '$1'), vars, new Set())
    const second = resolve(mix[3].replace(/^var\((--[\w-]+)\)$/, '$1'), vars, new Set())
    const weight = Number(mix[2]) / 100

    if (second.a === 0) {
      return { r: first.r, g: first.g, b: first.b, a: first.a * weight }
    }
    return {
      r: first.r * weight + second.r * (1 - weight),
      g: first.g * weight + second.g * (1 - weight),
      b: first.b * weight + second.b * (1 - weight),
      a: 1,
    }
  }

  throw new Error(`Token "${token}" is not derivable from the six pigments: ${raw}`)
}

const CSS = readFileSync(join(process.cwd(), 'src/app/globals.css'), 'utf8')
const DECLARATIONS = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const LIGHT = extractBlock(CSS, ':root')
const DARK = { ...LIGHT, ...extractBlock(CSS, '.dark') }

const PIGMENTS = {
  '--brand-burgundy': '#5a2331',
  '--brand-burgundy-deep': '#250e14',
  '--brand-ochre': '#c0873a',
  '--brand-cream': '#f6f3ec',
  '--brand-navy': '#0e1a2b',
  '--brand-grey': '#6a7689',
} as const

const RETIRED = ['#f1efe8', '#a06f2d', '#c9674f', '#e1d4d6', '#20201c', '#5f5256', '#b08a4a']

describe('Sherlock brand system v1.0 — six pigments', () => {
  it('declares exactly the six pigments and nothing else as a brand hex', () => {
    for (const [token, value] of Object.entries(PIGMENTS)) {
      expect(toHex(resolve(token, LIGHT))).toBe(value)
    }

    // Scan EVERY declaration, not just the --brand- prefix, at any hex length
    // and either case: a seventh colour does not have to be politely named.
    const declaredHexes = [
      ...DECLARATIONS.matchAll(/^\s*(--[\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/gm),
    ].map((entry) => [entry[1], entry[2].toLowerCase()] as const)

    for (const [token, value] of declaredHexes) {
      expect(ALLOWED_HEXES.has(value), `${token} declares a non-pigment hex ${value}`).toBe(true)
    }

    const pigmentTokens = declaredHexes
      .filter(([token]) => token.startsWith('--brand-'))
      .map(([token]) => token)
    expect(pigmentTokens.sort()).toEqual(Object.keys(PIGMENTS).sort())
  })

  it('keeps retired values out of the executable tokens', () => {
    for (const retired of RETIRED) {
      expect(DECLARATIONS.toLowerCase()).not.toContain(retired)
    }
  })

  it('derives every semantic token from a pigment, never from a new hex', () => {
    const semantic = [
      '--background',
      '--foreground',
      '--card',
      '--popover',
      '--primary',
      '--primary-foreground',
      '--secondary',
      '--muted',
      '--muted-foreground',
      '--meta-foreground',
      '--accent',
      '--accent-foreground',
      '--highlight',
      '--highlight-foreground',
      '--border',
      '--input',
      '--ring',
      '--sidebar',
      '--chart-1',
      '--chart-2',
      '--chart-3',
      '--chart-4',
      '--chart-5',
    ]

    for (const theme of [LIGHT, DARK]) {
      for (const token of semantic) {
        expect(() => resolve(token, theme)).not.toThrow()
      }
    }
  })
})

describe('Sherlock brand system v1.0 — light theme inversion', () => {
  const bg = () => resolve('--background', LIGHT)
  const card = () => resolve('--card', LIGHT)

  it('paints the light canvas and card in crema, separated by a border', () => {
    expect(toHex(bg())).toBe('#f6f3ec')
    expect(toHex(card())).toBe('#f6f3ec')
    expect(toHex(resolve('--foreground', LIGHT))).toBe('#0e1a2b')
    expect(toHex(resolve('--accent', LIGHT))).toBe('#5a2331')
  })

  it('keeps every light text role at AA on crema', () => {
    expect(contrastRatio(resolve('--foreground', LIGHT), bg())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--muted-foreground', LIGHT), bg())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--accent', LIGHT), bg())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--accent', LIGHT), card())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--badge-fg', LIGHT), bg())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--badge-fg', LIGHT), card())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--destructive', LIGHT), bg())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--destructive', LIGHT), card())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--warning', LIGHT), bg())).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(resolve('--info', LIGHT), bg())).toBeGreaterThanOrEqual(4.5)
  })

  it('reserves grey for non-body roles and navy for focus', () => {
    const grey = contrastRatio(resolve('--meta-foreground', LIGHT), bg())
    expect(grey).toBeGreaterThanOrEqual(3)
    expect(grey).toBeLessThan(4.5)

    expect(contrastRatio(resolve('--ring', LIGHT), bg())).toBeGreaterThanOrEqual(3)
  })

  it('pairs button labels with the surface that actually carries them', () => {
    expect(
      contrastRatio(resolve('--primary-foreground', LIGHT), resolve('--primary', LIGHT))
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(resolve('--highlight-foreground', LIGHT), resolve('--highlight', LIGHT))
    ).toBeGreaterThanOrEqual(4.5)
  })
})

describe('Sherlock brand system v1.0 — dark theme inversion', () => {
  const bg = () => resolve('--background', DARK)
  const card = () => resolve('--card', DARK)

  it('swaps crema and borgoña deep as the canvas, borgoña as the surface', () => {
    expect(toHex(bg())).toBe('#250e14')
    expect(toHex(card())).toBe('#5a2331')
    expect(toHex(resolve('--foreground', DARK))).toBe('#f6f3ec')
    expect(toHex(resolve('--highlight', DARK))).toBe('#c0873a')
  })

  it('keeps every dark text role at AA on both the canvas and the card', () => {
    for (const surface of [bg(), card()]) {
      expect(contrastRatio(resolve('--foreground', DARK), surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(resolve('--muted-foreground', DARK), surface)).toBeGreaterThanOrEqual(
        4.5
      )
    }
    expect(contrastRatio(resolve('--accent', DARK), bg())).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(resolve('--popover-foreground', DARK), resolve('--popover', DARK))
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(resolve('--sidebar-foreground', DARK), resolve('--sidebar', DARK))
    ).toBeGreaterThanOrEqual(4.5)
  })

  it('holds the 3:1 border invariant that carries dark structure', () => {
    for (const surface of [bg(), card()]) {
      expect(contrastRatio(resolve('--border', DARK), surface)).toBeGreaterThanOrEqual(3)
      expect(contrastRatio(resolve('--input', DARK), surface)).toBeGreaterThanOrEqual(3)
    }
    expect(contrastRatio(resolve('--ring', DARK), bg())).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(resolve('--ring', DARK), card())).toBeGreaterThanOrEqual(3)
  })

  it('lifts ochre before it is text on a card, keeping it pure for geometry', () => {
    // The brand system publishes 5.88:1 for ochre in dark — that is against the
    // canvas. On a burgundy card pure ochre measures 3.93:1, which axe caught.
    for (const token of ['--primary', '--accent', '--warning', '--badge-fg', '--sidebar-primary']) {
      for (const surface of [bg(), card()]) {
        expect(
          contrastRatio(resolve(token, DARK), surface),
          `${token} carries text and must clear AA on every dark surface`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }

    // Pure ochre stays where 3:1 is the bar, so the anchor colour survives.
    expect(toHex(resolve('--highlight', DARK))).toBe('#c0873a')
    expect(toHex(resolve('--ring', DARK))).toBe('#c0873a')
    expect(contrastRatio(resolve('--highlight', DARK), card())).toBeGreaterThanOrEqual(3)
  })

  it('pairs the ochre CTA with navy, never with crema', () => {
    expect(
      contrastRatio(resolve('--primary-foreground', DARK), resolve('--primary', DARK))
    ).toBeGreaterThanOrEqual(4.5)
    expect(
      contrastRatio(resolve('--accent-foreground', DARK), resolve('--accent', DARK))
    ).toBeGreaterThanOrEqual(4.5)
  })
})

describe('Sherlock brand system v1.0 — the three prohibitions', () => {
  it('proves ochre can never be text on crema', () => {
    expect(
      contrastRatio(resolve('--brand-ochre', LIGHT), resolve('--brand-cream', LIGHT))
    ).toBeLessThan(3)
    expect(toHex(resolve('--foreground', LIGHT))).not.toBe('#c0873a')
    expect(toHex(resolve('--muted-foreground', LIGHT))).not.toBe('#c0873a')
  })

  it('proves grey can never sit on borgoña, so dark cards use crema 70%', () => {
    expect(
      contrastRatio(resolve('--brand-grey', DARK), resolve('--brand-burgundy', DARK))
    ).toBeLessThan(3)
    expect(toHex(resolve('--muted-foreground', DARK))).not.toBe('#6a7689')
  })

  it('proves navy and borgoña annul each other, so no surface pairs them', () => {
    expect(
      contrastRatio(resolve('--brand-navy', DARK), resolve('--brand-burgundy', DARK))
    ).toBeLessThan(3)
    expect(toHex(resolve('--foreground', DARK))).not.toBe('#0e1a2b')
    expect(toHex(resolve('--card', LIGHT))).not.toBe('#5a2331')
  })
})

describe('Sherlock brand system v1.0 — coverage the hand-written lists missed', () => {
  /**
   * Deriving the pairs from `@theme inline` instead of hand-listing them is the
   * point: a `--x-foreground` added later is covered automatically. The previous
   * version enumerated six pairs by hand and silently omitted --card-foreground,
   * so a dropped dark override would have shipped green.
   */
  const PAIRS = [
    ...CSS.matchAll(/^\s*--color-([\w-]+)-foreground:\s*var\(--([\w-]+)-foreground\);/gm),
  ].map((m) => m[1])

  it('found the foreground pairs in @theme inline', () => {
    expect(PAIRS).toContain('card')
    expect(PAIRS).toContain('popover')
    expect(PAIRS).toContain('sidebar')
    expect(PAIRS.length).toBeGreaterThanOrEqual(8)
  })

  it('holds AA for every declared foreground on its own surface, in both themes', () => {
    for (const [themeName, theme] of [
      ['light', LIGHT],
      ['dark', DARK],
    ] as const) {
      for (const role of PAIRS) {
        const surface = `--${role}`
        const fg = `--${role}-foreground`
        if (!theme[surface] || !theme[fg]) continue
        expect(
          contrastRatio(resolve(fg, theme), resolve(surface, theme)),
          `${fg} on ${surface} in ${themeName}`
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
  })

  /**
   * The shadcn destructive variants paint `dark:bg-destructive/60`, so in dark
   * the label never lands on the solid token — it lands on a 60% wash over
   * whatever surface is behind. Asserting the solid pair passes while the real
   * one fails is exactly how this shipped at 3.72:1.
   */
  it('holds AA for the destructive label on the 60% dark wash, on every surface', () => {
    const fill = resolve('--destructive', DARK)
    const label = resolve('--destructive-foreground', DARK)
    for (const surface of ['--background', '--card', '--popover', '--sidebar']) {
      const washed = over({ ...fill, a: 0.6 }, resolve(surface, DARK))
      expect(
        contrastRatio(label, washed),
        `destructive label on a 60% fill over ${surface}`
      ).toBeGreaterThanOrEqual(4.5)
    }
  })

  /**
   * Chart tokens are consumed as bar fills, legend dots AND text
   * (`text-chart-*` in AdminDashboardClient), so 3:1 is not the bar for them.
   * Pure ochre as a light legend dot measured 2.80:1 and pure grey as a dark
   * one measured 2.66:1 — the palette's own prohibitions, applied to a chart.
   */
  it('holds AA for every chart series on the surface it is drawn on', () => {
    for (const [themeName, theme, surfaces] of [
      ['light', LIGHT, ['--background', '--card']],
      ['dark', DARK, ['--background', '--card']],
    ] as const) {
      for (const n of [1, 2, 3, 4, 5]) {
        for (const surface of surfaces) {
          expect(
            contrastRatio(resolve(`--chart-${n}`, theme), resolve(surface, theme)),
            `--chart-${n} on ${surface} in ${themeName}`
          ).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('keeps the two light border tiers distinct, and the dark 3:1 tier everywhere', () => {
    expect(toHex(resolve('--border-hairline', LIGHT))).not.toBe(toHex(resolve('--border', LIGHT)))

    for (const token of ['--border', '--input', '--sidebar-border']) {
      for (const surface of ['--background', '--card']) {
        expect(
          contrastRatio(resolve(token, DARK), resolve(surface, DARK)),
          `${token} on ${surface} in dark must clear the 3:1 structure invariant`
        ).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

describe('Sherlock brand system v1.0 — surfaces that cannot use var()', () => {
  /**
   * Email HTML and the NDA print templates bake hex literals, so no theme test
   * ever saw them: three retired values survived the migration there and would
   * have gone out to every counterparty. These files are the product's most
   * outward-facing surface and the least covered.
   */
  const BAKED_SURFACES = [
    '../../../convex/_helpers/emailTemplates.ts',
    '../../../convex/_helpers/teamEmailTemplates.ts',
    '../../../convex/_guests/delivery.ts',
  ]

  it('keeps retired hexes out of email and document templates', () => {
    for (const relative of BAKED_SURFACES) {
      const source = readFileSync(join(__dirname, relative), 'utf8').toLowerCase()
      for (const retired of [...RETIRED, '#171412', '#2a3a52', '#d9d2c2', '#fbf9f4']) {
        expect(source, `${relative} still bakes the retired ${retired}`).not.toContain(retired)
      }
    }
  })
})
