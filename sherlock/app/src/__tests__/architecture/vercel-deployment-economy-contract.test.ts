import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

const vercelConfigSchema = z.object({
  git: z.object({
    deploymentEnabled: z.literal(false),
  }),
})

describe('Vercel deployment economy contract', () => {
  it('keeps every Git branch from deploying automatically', () => {
    const raw: unknown = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))
    const config = vercelConfigSchema.parse(raw)

    expect(config.git.deploymentEnabled).toBe(false)
  })
})
