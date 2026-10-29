import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const appRoot = process.cwd()
const schemaSource = readFileSync(join(appRoot, 'convex/schema.ts'), 'utf8')

describe('VDR + WorkOS schema boundary', () => {
  it('keeps users provider-neutral while preserving legacy Clerk lookup during migration', () => {
    expect(schemaSource).toContain('authProvider')
    expect(schemaSource).toContain('providerUserId')
    expect(schemaSource).toContain('workosUserId')
    expect(schemaSource).toContain('by_providerUserId')
    expect(schemaSource).toContain('by_workosUserId')
    expect(schemaSource).toContain('clerkId')
  })

  it('stores WorkOS organization membership mappings separately from Sherlock business entities', () => {
    expect(schemaSource).toContain('organizationMemberships')
    expect(schemaSource).toContain('workosOrgId')
    expect(schemaSource).toContain('betaRole')
    expect(schemaSource).toContain('by_workosOrgId')
  })

  it('requires VDR document provenance tags for public-source and synthetic-demo separation', () => {
    expect(schemaSource).toContain('sourceType')
    expect(schemaSource).toContain('PUBLIC_SOURCE')
    expect(schemaSource).toContain('SYNTHETIC_DEMO')
    expect(schemaSource).toContain('sourceUrl')
  })
})
