// El TSV de `screens:sitio` tiene que llevar el mismo sufijo de esquema que
// los PNG: sin sufijo en claro, `_dark` en oscuro. Si no, `--scheme dark`
// pisa el inventario del claro (OB-RES-5-2).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(resolve(process.cwd(), '../../scripts/site-screenshots.mjs'), 'utf8')

describe('site-screenshots.mjs nombre de salida', () => {
  it('el TSV usa el mismo sufijo de esquema que el PNG', () => {
    expect(SOURCE).toContain('const schemeSuffix = scheme === "dark" ? "_dark" : ""')
    expect(SOURCE).toContain('const userSlug = `${user.split("@")[0]}${schemeSuffix}`')
    expect(SOURCE).toContain('join(out, `${userSlug}.tsv`)')
    expect(SOURCE).toContain('const slug = `${userSlug}${route.replace(/\\//g, "_")}`')
  })
})
