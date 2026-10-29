// ============================================================================
// Candado: todo `namespace: 'x.y.meta'` que una página pide a next-intl existe
// en es.json con `title` y `description`. `next build` registra un
// MISSING_MESSAGE sin fallar y el título sale como la clave cruda
// (`terms.meta.title | Sherlock` en prod el 2026-09-11 tras #594).
// ============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import esMessages from '@/messages/es.json'

const APP_DIR = join(process.cwd(), 'src', 'app')
// Dos formas de pedir metadata: `getTranslations({ namespace: 'x.meta' })` y
// `loadAdminTranslations(locale, 'admin.x.metadata')`; `.meta` y `.metadata`.
const NAMESPACE_PATTERNS = [
  /namespace:\s*(['"])([a-zA-Z0-9_.]+\.meta(?:data)?)\1/g,
  /loadAdminTranslations\(\s*locale,\s*(['"])([a-zA-Z0-9_.]+\.metadata)\1/g,
]
// `site.meta` es el único que no trae `title`: las páginas que lo piden toman
// el título de su propio namespace y de aquí solo `description` e `imageAlt`.
const DESCRIPTION_ONLY = new Set(['site.meta'])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.(ts|tsx)$/.test(entry) ? [full] : []
  })
}

function resolvePath(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => {
    if (node === null || typeof node !== 'object') return undefined
    return (node as Record<string, unknown>)[key]
  }, root)
}

describe('page metadata namespaces', () => {
  const namespaces = new Map<string, string[]>()
  for (const file of walk(APP_DIR)) {
    const source = readFileSync(file, 'utf8')
    for (const pattern of NAMESPACE_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const namespace = match[2] as string
        namespaces.set(namespace, [
          ...(namespaces.get(namespace) ?? []),
          file.slice(APP_DIR.length),
        ])
      }
    }
  }

  it('finds the namespaces pages read for metadata', () => {
    expect(namespaces.size).toBeGreaterThanOrEqual(11)
    expect(namespaces.has('terms.meta')).toBe(true)
    expect(namespaces.has('legal.meta')).toBe(true)
    expect(namespaces.has('devLogin.metadata')).toBe(true)
    expect(namespaces.has('admin.security.metadata')).toBe(true)
  })

  it.each([...namespaces.entries()])(
    '%s exists in es.json with title and description',
    (namespace, files) => {
      const node = resolvePath(esMessages, namespace)
      expect(node, `${namespace} pedido por ${files.join(', ')}`).toBeTypeOf('object')
      expect(resolvePath(node, 'description')).toBeTypeOf('string')
      if (!DESCRIPTION_ONLY.has(namespace)) expect(resolvePath(node, 'title')).toBeTypeOf('string')
    }
  )
})
