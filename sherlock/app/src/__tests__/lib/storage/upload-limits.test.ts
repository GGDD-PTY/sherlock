// ============================================================================
// UPLOAD LIMITS — PLATFORM-AWARE FILE SIZE CAP
// ============================================================================
// Regresión del bug de producción 2026-07-31: Vercel rechaza cualquier body
// mayor a ~4.5MB con un 413 FUNCTION_PAYLOAD_TOO_LARGE en texto plano ANTES de
// que la ruta corra (sin auth, sin log, sin auditoría). Los uploaders
// anunciaban 50MB y parseaban la respuesta con response.json(), así que el
// usuario veía un error críptico o genérico. Verificado empíricamente contra
// https://www.sherlock.capital/api/upload (POST de 6MB → 413 texto plano).
//
// Evolución (decisión 6, DESIGN-ONBOARDING-VDR-2026-07-31): el VDR migró a la
// subida DIRECTA navegador → Convex Storage (generateUploadUrl → POST a
// *.convex.cloud → registerDirectUpload), que no pasa por Vercel. El techo de
// 4MB queda SOLO para las superficies que siguen viajando por /api; el camino
// directo declara su techo real de 50MB, validado server-side en Convex contra
// el tamaño real del blob.
// ============================================================================

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  PLATFORM_REQUEST_BODY_LIMIT_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_MB,
  MAX_DIRECT_UPLOAD_BYTES,
  MAX_DIRECT_UPLOAD_MB,
  MAX_CSV_UPLOAD_BYTES,
  directUploadLimitBytesForMimeType,
} from '@/lib/storage/upload-limits'
import {
  MAX_DIRECT_UPLOAD_BYTES as CONVEX_MAX_DIRECT_UPLOAD_BYTES,
  MAX_CSV_UPLOAD_BYTES as CONVEX_MAX_CSV_UPLOAD_BYTES,
  DIRECT_UPLOAD_ALLOWED_MIME_TYPES,
} from '../../../../convex/_documents/uploadLimits'

// ============================================================================
// CONSTANTES
// ============================================================================

describe('upload limits constants', () => {
  it('keeps the effective cap under the Vercel request-body limit with margin', () => {
    // 4.5MB is the documented Vercel serverless request-body limit. The
    // effective cap must leave room for multipart boundaries + form fields.
    expect(PLATFORM_REQUEST_BODY_LIMIT_BYTES).toBe(Math.floor(4.5 * 1024 * 1024))
    expect(MAX_UPLOAD_BYTES).toBeLessThan(PLATFORM_REQUEST_BODY_LIMIT_BYTES)
    // At least 256KB of margin for multipart overhead and metadata fields.
    expect(PLATFORM_REQUEST_BODY_LIMIT_BYTES - MAX_UPLOAD_BYTES).toBeGreaterThanOrEqual(256 * 1024)
  })

  it('exposes a human-readable MB figure consistent with the byte cap', () => {
    expect(MAX_UPLOAD_MB).toBe(MAX_UPLOAD_BYTES / 1024 / 1024)
    expect(Number.isInteger(MAX_UPLOAD_MB)).toBe(true)
  })
})

// ============================================================================
// CONSTANTES DEL CAMINO DIRECTO (navegador → Convex Storage)
// ============================================================================

describe('direct upload limits', () => {
  it('declares the real 50MB product cap — above the Vercel limit on purpose', () => {
    // La razón de ser del camino directo: el archivo no pasa por Vercel, así
    // que el techo del producto (lo que la UI siempre anunció) vuelve a regir.
    expect(MAX_DIRECT_UPLOAD_BYTES).toBe(50 * 1024 * 1024)
    expect(MAX_DIRECT_UPLOAD_BYTES).toBeGreaterThan(PLATFORM_REQUEST_BODY_LIMIT_BYTES)
  })

  it('exposes a human-readable MB figure consistent with the byte cap', () => {
    expect(MAX_DIRECT_UPLOAD_MB).toBe(MAX_DIRECT_UPLOAD_BYTES / 1024 / 1024)
    expect(Number.isInteger(MAX_DIRECT_UPLOAD_MB)).toBe(true)
  })

  it('re-exports the exact Convex source of truth — UI and mutation validate the same number', () => {
    expect(MAX_DIRECT_UPLOAD_BYTES).toBe(CONVEX_MAX_DIRECT_UPLOAD_BYTES)
  })

  it('applies the 20 MB CSV ceiling without lowering PDF or Office', () => {
    expect(MAX_CSV_UPLOAD_BYTES).toBe(20 * 1024 * 1024)
    expect(MAX_CSV_UPLOAD_BYTES).toBe(CONVEX_MAX_CSV_UPLOAD_BYTES)
    expect(MAX_CSV_UPLOAD_BYTES).toBeLessThan(MAX_DIRECT_UPLOAD_BYTES)
    expect(directUploadLimitBytesForMimeType('text/csv')).toBe(MAX_CSV_UPLOAD_BYTES)
    expect(directUploadLimitBytesForMimeType(' TEXT/CSV ')).toBe(MAX_CSV_UPLOAD_BYTES)
    expect(directUploadLimitBytesForMimeType('application/pdf')).toBe(MAX_DIRECT_UPLOAD_BYTES)
    expect(directUploadLimitBytesForMimeType('application/vnd.ms-excel')).toBe(
      MAX_DIRECT_UPLOAD_BYTES
    )
  })

  it('keeps the direct-path MIME allowlist in parity with /api/documents/upload', () => {
    // El camino directo no puede aceptar tipos que la ruta /api rechazaría:
    // misma allowlist (PDF + Office), verificada contra el source de la ruta.
    const routeSource = readFileSync(
      path.join(APP_ROOT, 'src/app/api/documents/upload/route.ts'),
      'utf-8'
    )

    expect(DIRECT_UPLOAD_ALLOWED_MIME_TYPES.length).toBeGreaterThanOrEqual(7)
    for (const mimeType of DIRECT_UPLOAD_ALLOWED_MIME_TYPES) {
      expect(routeSource, `${mimeType} missing from the /api route allowlist`).toContain(
        `'${mimeType}'`
      )
    }
  })
})

// ============================================================================
// GUARDIA DE ARQUITECTURA — cada superficie de subida usa el techo de su camino
// ============================================================================
// Evolución honesta del guard de #232. Dos lanes con contratos distintos:
//
// 1. Superficies que siguen viajando por una ruta Next en Vercel (logo y las
//    rutas /api vivas): ningún límite por encima de la plataforma —
//    Vercel lo rechazaría con un 413 que la app nunca ve.
// 2. Superficies de documentos VDR migradas al camino directo navegador →
//    Convex Storage: no pueden volver al POST por /api (re-introduciría el
//    techo de ~4.5MB en silencio) ni declarar límites propios — el techo vive
//    en el módulo compartido y se valida server-side contra el blob real.

const APP_ROOT = path.resolve(__dirname, '../../../..')

const MB_LITERAL_PATTERN = /(\d+(?:\.\d+)?)\s*\*\s*1024\s*\*\s*1024/g

// Superficies cuyo body SÍ pasa por una serverless function de Vercel.
const API_PATH_UPLOAD_SURFACES = [
  'src/app/api/upload/route.ts',
  'src/app/api/documents/upload/route.ts',
  'src/lib/storage/index.ts',
]

// Superficies de documentos migradas al camino directo (decisión 6).
const DIRECT_UPLOAD_SURFACES = ['src/components/company/MyCompanyDocumentsClient.tsx']

describe('api-path upload surfaces stay under the platform body limit', () => {
  it.each(API_PATH_UPLOAD_SURFACES)(
    '%s declares no MB literal above the platform cap',
    (relativePath) => {
      const source = readFileSync(path.join(APP_ROOT, relativePath), 'utf-8')
      const mbLiterals = [...source.matchAll(MB_LITERAL_PATTERN)]

      for (const match of mbLiterals) {
        const bytes = Number(match[1]) * 1024 * 1024
        expect(
          bytes,
          `${relativePath} declares a ${match[1]}MB limit above the ~4.5MB Vercel request-body cap`
        ).toBeLessThanOrEqual(PLATFORM_REQUEST_BODY_LIMIT_BYTES)
      }
    }
  )
})

describe('direct-path document surfaces never fall back to the Vercel lane', () => {
  it.each(DIRECT_UPLOAD_SURFACES)('%s uploads through the direct path only', (relativePath) => {
    const source = readFileSync(path.join(APP_ROOT, relativePath), 'utf-8')

    // Volver a POSTear el archivo a /api/documents/upload re-introduce el 413.
    expect(
      source.includes('/api/documents/upload'),
      `${relativePath} references /api/documents/upload — the direct path never posts files through Vercel`
    ).toBe(false)

    // La subida pasa por el hook del camino directo (presigned + registro).
    expect(
      source.includes('useDirectVdrUpload'),
      `${relativePath} must upload via useDirectVdrUpload`
    ).toBe(true)

    // El techo de 4MB es del carril /api; usarlo aquí mentiría al usuario.
    expect(
      /\bMAX_UPLOAD_BYTES\b|\bMAX_UPLOAD_MB\b/.test(source),
      `${relativePath} imports the 4MB api-path cap — direct surfaces use MAX_DIRECT_UPLOAD_*`
    ).toBe(false)

    // Ningún literal de MB: el techo directo vive en el módulo compartido.
    expect(
      [...source.matchAll(MB_LITERAL_PATTERN)],
      `${relativePath} declares an inline MB literal — import the shared direct-upload cap instead`
    ).toHaveLength(0)
  })
})
