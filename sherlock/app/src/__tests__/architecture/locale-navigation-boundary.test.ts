// ============================================================================
// LOCALE NAVIGATION BOUNDARY
// ============================================================================
// Every internal URL this app generates must carry a locale prefix.
//
// WHY THIS IS A BOUNDARY AND NOT A STYLE RULE
// -------------------------------------------
// `localePrefix: 'always'` means /es/... and /en/... are the only real routes.
// A locale-LESS internal URL is not a 404 — it is worse. It reaches the edge
// (src/proxy.ts), where next-intl re-negotiates a locale from the NEXT_LOCALE
// cookie / Accept-Language and 307s the visitor somewhere. Two live failures
// came out of exactly that (staging walkthrough, 2026-07-25):
//
//   1. An English visitor whose cookie says `es` (set the moment they hit the
//      bare domain: `/` -> 307 /es + NEXT_LOCALE=es) is silently dropped into
//      Spanish by every locale-less link. Switching language "fixes" it only
//      until the next locale-less href, because the cookie is the memory.
//   2. Before the proxy learned to negotiate nested locale-less paths, a
//      locale-less PUBLIC teaser (/deals/<id>, from global search or a copied
//      share link) 307'd a guest to WorkOS sign-in — while /en/deals/<id>
//      served 200. Public content demanded a login.
//
// The generators are what leak, so the generators are what this pins:
// `Link` / `useRouter` / `usePathname` from the raw Next.js modules drop the
// locale silently, and a locale-less path smuggled through a `redirect_url=` /
// `returnTo=` query value survives even a correct <Link>, because next-intl
// prefixes the href's pathname and never its query string.
//
// Use `@/i18n/navigation` (Link, useRouter, usePathname, redirect, getPathname).
// ============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC_DIR = join(process.cwd(), 'src')

// ===== ALLOWLIST: files that legitimately reach for the raw primitives =====
// Each entry needs a reason. This list may shrink; adding to it means arguing
// that the file genuinely cannot know a locale.
const RAW_NAVIGATION_ALLOWLIST: Record<string, string> = {
  // Renders its own <html> OUTSIDE the [locale] segment (Next's
  // global-not-found convention), so no locale context exists to read. Its
  // hrefs are deliberately locale-LESS so the edge negotiates per visitor.
  'src/app/global-not-found.tsx': 'renders outside the [locale] segment',
  // Root route handlers, also outside [locale]. They redirect to an explicit
  // `/${defaultLocale}` or to an external WorkOS URL.
  'src/app/route.ts': 'root route handler, redirects to defaultLocale',
  'src/app/login/route.ts': 'root route handler, redirects to WorkOS',
  'src/app/signup/route.ts': 'root route handler, redirects to WorkOS',
}

// Directories excluded wholesale, matching the precedent set by
// i18n-hardcode-guard.test.ts.
const EXCLUDED_DIRS = [
  join('src', '__tests__'),
  join('src', 'components', 'ui'), // vendored shadcn primitives
  join('src', 'components', 'dev'), // dev-only tooling, never in production
]

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      sourceFiles(full, acc)
    } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      acc.push(full)
    }
  }
  return acc
}

function auditedFiles(): Array<{ path: string; source: string }> {
  return sourceFiles(SRC_DIR)
    .map((full) => ({ path: relative(process.cwd(), full).split(sep).join('/'), full }))
    .filter(({ path }) => !EXCLUDED_DIRS.some((dir) => path.startsWith(dir.split(sep).join('/'))))
    .map(({ path, full }) => ({ path, source: readFileSync(full, 'utf8') }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Import specifiers pulled from a given module, e.g. `next/navigation`.
 *
 * The clause pattern must exclude the keyword `import` rather than `;`: Prettier
 * runs with `semi: false` here, so a `[^;]+?` clause happily spans newlines and
 * swallows every preceding import in the file, leaving this function reading the
 * WRONG brace group. That bug shipped in the first draft of this guard and hid
 * 10 of 11 real violations, which is precisely the failure it exists to catch.
 */
function importedFrom(source: string, module: string): string[] {
  const names: string[] = []
  const pattern = new RegExp(
    `import\\s+((?:(?!\\bimport\\b)[\\s\\S])+?)\\s+from\\s+'${module}'`,
    'g'
  )
  for (const match of source.matchAll(pattern)) {
    const clause = match[1]
    const named = clause.match(/\{([^}]*)\}/)
    if (named) {
      for (const part of named[1].split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)[0]
          .trim()
        if (name) names.push(name)
      }
    }
    const defaultImport = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim()
    if (defaultImport) names.push(defaultImport)
  }
  return names
}

// `useSearchParams`, `useParams`, `notFound`, `useSelectedLayoutSegment` and
// friends carry no locale, so importing them from next/navigation is correct.
const LOCALE_CARRYING_NAVIGATION_EXPORTS = ['useRouter', 'usePathname']

describe('locale navigation boundary', () => {
  it('routes every component through @/i18n/navigation instead of next/link', () => {
    const offenders = auditedFiles()
      .filter(({ path }) => !(path in RAW_NAVIGATION_ALLOWLIST))
      .filter(({ source }) => importedFrom(source, 'next/link').length > 0)
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  it('routes every component through @/i18n/navigation instead of next/navigation', () => {
    const offenders = auditedFiles()
      .filter(({ path }) => !(path in RAW_NAVIGATION_ALLOWLIST))
      .filter(({ source }) =>
        importedFrom(source, 'next/navigation').some((name) =>
          LOCALE_CARRYING_NAVIGATION_EXPORTS.includes(name)
        )
      )
      .map(({ path }) => path)

    expect(offenders).toEqual([])
  })

  it('keeps a locale prefix on paths smuggled through redirect_url / returnTo query values', () => {
    // next-intl prefixes an href's PATHNAME and leaves its query string alone,
    // so `<Link href="/sign-in?redirect_url=/deals/1">` yields
    // /es/sign-in?redirect_url=/deals/1 — correct link, locale-less landing.
    // A locale-less value here is allowed only when it is a `${locale}` or
    // `${defaultLocale}` template, or an encodeURIComponent(...) expression
    // that carries one.
    const offenders: string[] = []

    for (const { path, source } of auditedFiles()) {
      for (const match of source.matchAll(/(redirect_url|returnTo)=([^\s"'`&]*)/g)) {
        const value = match[2]
        if (!value.startsWith('/') && !value.startsWith('$')) continue // dynamic or empty
        if (/^\/\$\{(locale|defaultLocale)\}/.test(value)) continue // already prefixed
        if (value.startsWith('$')) continue // whole value is an expression
        offenders.push(`${path}: ${match[0]}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
