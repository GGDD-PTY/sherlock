// ============================================================================
// LOCALE EN LINKS SERVER-SIDE — setRequestLocale en páginas server
// ============================================================================
// Bug de producción (QA 2026-07-30): /en/deals renderizaba las cards con
// hrefs /es/deals/<id>. Causa: el proxy (applyAuthkitState con
// includeRequestHeaders) pisa el header de request de next-intl, así que el
// locale implícito del request nunca se resuelve en el render y los <Link> de
// '@/i18n/navigation' renderizados en el servidor caen al defaultLocale 'es'.
// El arreglo determinista es que CADA página server que renderice navegación
// i18n llame setRequestLocale(locale) (patrón documentado de next-intl:
// llamarlo en cada layout y página).
//
// Este test barre el árbol de rutas y fija esa invariante para que ninguna
// página nueva reintroduzca la clase completa del bug.
// ============================================================================

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const LOCALE_APP_DIR = join(process.cwd(), 'src/app/[locale]')

function collectPageFiles(dir: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      result.push(...collectPageFiles(fullPath))
    } else if (entry.name === 'page.tsx') {
      result.push(fullPath)
    }
  }
  return result
}

// Directiva real al inicio del archivo (ignorando comentarios y whitespace
// iniciales), con comillas simples o dobles — no menciones en comentarios.
function isServerComponent(source: string): boolean {
  const withoutLeadingComments = source.replace(/^(?:\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/, '')
  return !/^['"]use client['"]/.test(withoutLeadingComments)
}

// Statements reales anclados a inicio de línea — no menciones en comentarios.
const I18N_NAVIGATION_IMPORT = /^import .*from '@\/i18n\/navigation'/m
const SET_REQUEST_LOCALE_CALL = /^\s*setRequestLocale\(locale\)/m
const RELATIVE_IMPORT = /^import .*from '(\.[^']+)'/gm

// Un import relativo puede resolver a .tsx/.ts o a un index de carpeta.
function resolveRelativeImport(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    join(base, 'index.tsx'),
    join(base, 'index.ts'),
  ]
  for (const candidate of candidates) {
    if (candidate.endsWith('.tsx') || candidate.endsWith('.ts')) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function collectRelativeImports(source: string): string[] {
  return [...source.matchAll(RELATIVE_IMPORT)].map((match) => match[1])
}

// Una página server "renderiza navegación i18n" cuando importa
// '@/i18n/navigation' directamente O cuando compone (transitivamente, vía
// imports relativos bajo [locale]/) un componente server — sin 'use client' —
// que lo importa. Los Links server-side de esos hijos resuelven el locale del
// MISMO request que la página, así que la página sigue siendo la responsable
// de llamar setRequestLocale(locale). Un hijo client se excluye: su locale
// se resuelve en el cliente por contexto, no por el request. (Miss real de
// este bug: deals/[id]/page.tsx no importa la navegación pero compone
// DealAccessGate/DealDetailShell/DealSidebar/DealMainContent, que sí.)
function rendersI18nNavigation(file: string, visited = new Set<string>()): boolean {
  if (visited.has(file)) return false
  visited.add(file)

  const source = readFileSync(file, 'utf8')
  if (!isServerComponent(source)) return false
  if (I18N_NAVIGATION_IMPORT.test(source)) return true

  for (const specifier of collectRelativeImports(source)) {
    const resolved = resolveRelativeImport(file, specifier)
    if (!resolved) continue
    if (!resolved.startsWith(LOCALE_APP_DIR)) continue
    if (!resolved.endsWith('.tsx')) continue
    if (rendersI18nNavigation(resolved, visited)) return true
  }

  return false
}

describe('setRequestLocale en páginas server con navegación i18n', () => {
  const pages = collectPageFiles(LOCALE_APP_DIR)

  it('encuentra páginas bajo src/app/[locale] (sanity del barrido)', () => {
    expect(pages.length).toBeGreaterThan(29)
  })

  it('toda página server que renderiza navegación i18n (directa o compuesta) llama setRequestLocale', () => {
    const offenders: string[] = []

    for (const page of pages) {
      const source = readFileSync(page, 'utf8')
      if (!isServerComponent(source)) continue
      if (!rendersI18nNavigation(page)) continue
      if (!SET_REQUEST_LOCALE_CALL.test(source)) {
        offenders.push(page.replace(LOCALE_APP_DIR, '[locale]'))
      }
    }

    expect(
      offenders,
      `páginas server con Links i18n sin setRequestLocale:\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it('las páginas afectadas importan setRequestLocale de next-intl/server', () => {
    for (const page of pages) {
      const source = readFileSync(page, 'utf8')
      if (!isServerComponent(source)) continue
      if (!SET_REQUEST_LOCALE_CALL.test(source)) continue
      expect(source, page).toMatch(
        /^import \{[^}]*setRequestLocale[^}]*\} from 'next-intl\/server'/m
      )
    }
  })
})
