// ============================================================================
// STORAGE POLICY UNIT TESTS
// ============================================================================
// validateFile: tipo MIME y tamaño por bucket.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('lib/storage/index.ts', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // ============================================================================
  // validateFile TESTS
  // ============================================================================
  describe('validateFile', () => {
    // ===== TEST: VALIDATES ALLOWED TYPE FOR AVATARS =====
    it('returns valid for allowed file type (PNG for avatars)', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['content'], 'avatar.png', { type: 'image/png' })
      const result = validateFile(file, 'avatars')

      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    // ===== TEST: VALIDATES JPEG FOR AVATARS =====
    it('validates JPEG for avatars bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['content'], 'photo.jpg', { type: 'image/jpeg' })
      const result = validateFile(file, 'avatars')

      expect(result.valid).toBe(true)
    })

    // ===== TEST: VALIDATES WEBP FOR AVATARS =====
    it('validates WebP for avatars bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['content'], 'image.webp', { type: 'image/webp' })
      const result = validateFile(file, 'avatars')

      expect(result.valid).toBe(true)
    })

    // ===== TEST: REJECTS INVALID TYPE =====
    it('rejects invalid file type for avatars', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['content'], 'script.exe', {
        type: 'application/x-msdownload',
      })
      const result = validateFile(file, 'avatars')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('Tipo de archivo no permitido')
    })

    // ===== TEST: REJECTS OVERSIZED FILE =====
    it('rejects file exceeding size limit', async () => {
      const { validateFile } = await import('@/lib/storage')

      // Create a mock File that appears to be 10MB (avatar limit is the
      // platform-safe 4MB — see src/lib/storage/upload-limits.ts)
      const largeFile = new File(['x'.repeat(100)], 'large.png', {
        type: 'image/png',
      })
      Object.defineProperty(largeFile, 'size', { value: 10 * 1024 * 1024 })

      const result = validateFile(largeFile, 'avatars')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('muy grande')
      expect(result.error).toContain('4 MB')
    })

    // ===== TEST: VALIDATES PDF FOR DOCUMENTS =====
    it('validates PDF for documents bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['content'], 'document.pdf', {
        type: 'application/pdf',
      })
      const result = validateFile(file, 'documents')

      expect(result.valid).toBe(true)
    })

    // ===== TEST: VALIDATES XLSX FOR DOCUMENTS =====
    it('validates XLSX for documents bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['content'], 'spreadsheet.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      const result = validateFile(file, 'documents')

      expect(result.valid).toBe(true)
    })

    // ===== TEST: VALIDATES CSV FOR ANALYSES =====
    it('validates CSV for analyses bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['col1,col2\nval1,val2'], 'data.csv', {
        type: 'text/csv',
      })
      const result = validateFile(file, 'analyses')

      expect(result.valid).toBe(true)
    })

    // ===== TEST: VALIDATES JSON FOR ANALYSES =====
    it('validates JSON for analyses bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['{"key": "value"}'], 'data.json', {
        type: 'application/json',
      })
      const result = validateFile(file, 'analyses')

      expect(result.valid).toBe(true)
    })

    // ===== TEST: REJECTS SVG FOR LOGOS =====
    it('rejects SVG for logos bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['<svg></svg>'], 'logo.svg', {
        type: 'image/svg+xml',
      })
      const result = validateFile(file, 'logos')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('image/jpeg')
      expect(result.error).not.toContain('image/svg+xml')
    })

    // ===== TEST: REJECTS WRONG TYPE FOR BUCKET =====
    it('rejects PDF for avatars bucket', async () => {
      const { validateFile } = await import('@/lib/storage')

      const file = new File(['content'], 'document.pdf', {
        type: 'application/pdf',
      })
      const result = validateFile(file, 'avatars')

      expect(result.valid).toBe(false)
    })

    // ===== TEST: DOCUMENTS LIMIT IS PLATFORM-SAFE (4MB) =====
    // Vercel corta cualquier request body en ~4.5MB con un 413 que la app
    // nunca ve, así que todos los buckets anuncian el techo honesto de 4MB.
    it('documents bucket rejects files above the platform-safe limit', async () => {
      const { validateFile } = await import('@/lib/storage')

      const mediumFile = new File(['x'], 'large.pdf', {
        type: 'application/pdf',
      })
      Object.defineProperty(mediumFile, 'size', { value: 40 * 1024 * 1024 })

      const result = validateFile(mediumFile, 'documents')

      expect(result.valid).toBe(false)
      expect(result.error).toContain('4 MB')
    })

    it('documents bucket allows files within the platform-safe limit', async () => {
      const { validateFile } = await import('@/lib/storage')

      const smallFile = new File(['x'], 'deck.pdf', {
        type: 'application/pdf',
      })
      Object.defineProperty(smallFile, 'size', { value: 3 * 1024 * 1024 })

      const result = validateFile(smallFile, 'documents')

      expect(result.valid).toBe(true)
    })

    // ===== TEST: ANALYSES LIMIT IS PLATFORM-SAFE (4MB) =====
    it('analyses bucket rejects files above the platform-safe limit', async () => {
      const { validateFile } = await import('@/lib/storage')

      const largeFile = new File(['x'], 'analysis.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      })
      Object.defineProperty(largeFile, 'size', { value: 80 * 1024 * 1024 })

      const result = validateFile(largeFile, 'analyses')

      expect(result.valid).toBe(false)
    })
  })

  // ============================================================================
  // VALID_BUCKETS
  // ============================================================================
  describe('VALID_BUCKETS', () => {
    // ===== TEST: CADA BUCKET VALIDA LO SUYO =====
    // El caso anterior llamaba a `validateFile` por cada bucket y cerraba con
    // `expect(true).toBe(true)`: no afirmaba nada sobre el resultado, así que
    // aceptar un tipo prohibido en un bucket lo dejaba verde.
    it('cada bucket acepta su tipo de archivo y rechaza uno ajeno', async () => {
      const { validateFile, VALID_BUCKETS } = await import('@/lib/storage')

      const png = new File(['content'], 'test.png', { type: 'image/png' })
      const pdf = new File(['content'], 'test.pdf', { type: 'application/pdf' })

      expect(VALID_BUCKETS).toEqual(['avatars', 'logos', 'documents', 'analyses'])
      expect(validateFile(png, 'avatars')).toEqual({ valid: true })
      expect(validateFile(png, 'logos')).toEqual({ valid: true })
      expect(validateFile(pdf, 'documents')).toEqual({ valid: true })
      expect(validateFile(pdf, 'analyses')).toEqual({ valid: true })

      // Una imagen no es un documento del VDR ni un resultado de análisis.
      expect(validateFile(png, 'documents').valid).toBe(false)
      expect(validateFile(png, 'analyses').valid).toBe(false)
    })
  })
})
