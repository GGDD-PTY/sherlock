import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function readSurface(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

// El perfil y el editor del marketplace (CompanyEditClient, MyCompanyDocuments)
// salieron del árbol el 2026-09-07 ([F] 09:00: la información de la empresa
// vive en la sala). Lo que queda de este contrato es la copia de clasificación
// del VDR, que sigue nombrando las cinco clasificaciones en español y describe
// `isPublic` como material aprobado para compartir, nunca como marketplace.
describe('company surface copy contract', () => {
  it('describes approved sharing without marketplace language in the VDR config', () => {
    const vdr = readSurface('src/components/company/vdr/config.ts')

    expect(vdr).not.toContain('Visibilidad limitada en el marketplace')
    expect(vdr).not.toContain('Match aprobado, NDA activo y Contrato de Fee')
    expect(vdr).not.toContain('discovery inicial')
    expect(vdr).toContain('publicación limitada, revisada y auditada por el equipo')
  })

  // El colapso a un solo idioma dejó el inglés del slot `es` en dos etiquetas de
  // clasificación ("Public teaser", "KYC sensitive"): el VDR nombra las cinco
  // clasificaciones y tiene que decirlas en español.
  it('names every classification in Spanish in the VDR config', () => {
    const source = readSurface('src/components/company/vdr/config.ts')

    expect(source).toContain("label: { es: 'Teaser público' }")
    expect(source).toContain("label: { es: 'Confidencial' }")
    expect(source).toContain("label: { es: 'Restringido' }")
    expect(source).toContain("label: { es: 'Legal' }")
    expect(source).toContain("label: { es: 'Sensible para KYC' }")
    expect(source).not.toMatch(/Public teaser|KYC sensitive/)
  })
})
