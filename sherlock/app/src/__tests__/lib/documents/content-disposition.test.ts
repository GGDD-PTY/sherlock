// ============================================================================
// CONTENT-DISPOSITION (RFC 6266 / RFC 5987)
// ============================================================================
// Los nombres de archivo del VDR vienen del emisor y en LATAM traen acentos:
// "Presentación.pdf". El header debe conservarlos vía `filename*` sin perder el
// respaldo ASCII de `filename=` ni dejar pasar caracteres peligrosos.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  buildContentDisposition,
  sanitizeDownloadFileName,
} from '@/lib/documents/content-disposition'

describe('buildContentDisposition', () => {
  it('keeps accents in filename* while providing an ASCII filename fallback', () => {
    const header = buildContentDisposition('attachment', 'Presentación.pdf', 'documento')

    expect(header).toBe(
      `attachment; filename="Presentaci_n.pdf"; filename*=UTF-8''Presentaci%C3%B3n.pdf`
    )
  })

  it('emits both parameters for plain ASCII names too', () => {
    const header = buildContentDisposition('attachment', 'Model.xlsx', 'documento')

    expect(header).toBe(`attachment; filename="Model.xlsx"; filename*=UTF-8''Model.xlsx`)
  })

  it('uses the requested disposition for inline delivery', () => {
    const header = buildContentDisposition('inline', 'Memo.pdf', 'document.pdf')

    expect(header).toMatch(/^inline; filename="Memo\.pdf"/)
  })

  it('appends the forced extension to both variants', () => {
    const header = buildContentDisposition('inline', 'Presentación', 'document.pdf', {
      extension: 'pdf',
    })

    expect(header).toBe(
      `inline; filename="Presentaci_n.pdf"; filename*=UTF-8''Presentaci%C3%B3n.pdf`
    )
  })

  it('does not double an extension that already matches case-insensitively', () => {
    const header = buildContentDisposition('attachment', 'Modelo.XLSX', 'documento', {
      extension: 'xlsx',
    })

    expect(header).toContain('filename="Modelo.XLSX"')
    expect(header).not.toContain('.XLSX.xlsx')
    expect(header).not.toContain('.xlsx.xlsx')
  })

  it('strips header/path-dangerous characters from both variants', () => {
    const header = buildContentDisposition('attachment', 'a/b\\c:"d";e.pdf', 'documento')

    expect(header).not.toMatch(/[\\/:]/)
    expect(header).toContain('filename="a_b_c__d__e.pdf"')
    // Las comillas y separadores tampoco sobreviven percent-encodeados como
    // caracteres reales en filename*.
    expect(header).toContain(`filename*=UTF-8''a_b_c__d__e.pdf`)
  })

  it('percent-encodes RFC 5987 non-attr-chars that encodeURIComponent leaves alone', () => {
    const header = buildContentDisposition('attachment', "informe (v2) 'final'*.pdf", 'documento')

    const extended = header.split(`filename*=UTF-8''`)[1]
    expect(extended).not.toMatch(/['()*]/)
  })

  it('keeps a useful ASCII fallback for names that are entirely non-ASCII', () => {
    const header = buildContentDisposition('attachment', 'ñá', 'documento')

    expect(header).toContain('filename="documento"')
    expect(header).toContain(`filename*=UTF-8''%C3%B1%C3%A1`)
  })
})

describe('sanitizeDownloadFileName', () => {
  it('falls back when the sanitized name collapses to nothing', () => {
    expect(sanitizeDownloadFileName('ñá', 'documento')).toBe('documento')
  })

  it('truncates to 120 characters', () => {
    expect(sanitizeDownloadFileName('a'.repeat(300), 'documento')).toHaveLength(120)
  })
})
