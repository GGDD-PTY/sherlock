import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const APP_ROOT = path.resolve(PROJECT_ROOT, '..')

const ROUTE_ERROR_FILES = ['src/app/[locale]/(app)/admin/error.tsx'] as const

describe('route error sanitization', () => {
  it('does not render raw debug details on high-traffic route error pages', () => {
    const violations = ROUTE_ERROR_FILES.filter((file) => {
      const source = fs.readFileSync(path.join(APP_ROOT, file), 'utf8')
      return source.includes('Debug Info') || source.includes('{error.message}')
    })

    expect(violations).toEqual([])
  })
})
