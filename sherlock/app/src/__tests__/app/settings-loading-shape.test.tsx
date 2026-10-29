import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import SettingsLoading from '@/app/[locale]/(app)/settings/loading'
import PrivacyLoading from '@/app/[locale]/(app)/settings/privacy/loading'

const APP_ROOT = join(process.cwd(), 'src')
const read = (path: string) => readFileSync(join(APP_ROOT, path), 'utf8')

describe('settings loading copies the live page', () => {
  it('renders three cards and no tabs or toggles', () => {
    const { container } = render(<SettingsLoading />)

    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(3)
    expect(screen.queryAllByTestId('loading-skeleton-toggleRow')).toHaveLength(0)
    expect(container.querySelector('.mb-6.flex.gap-2')).toBeNull()
  })

  it('keeps the danger card distinct from the account cards', () => {
    const { container } = render(<SettingsLoading />)
    const cards = container.querySelectorAll('[data-slot="card"]')

    expect(cards[2]?.className).toContain('border-destructive/50')
  })
})

describe('privacy loading copies the live page', () => {
  it('renders rights, three consents, export and deletion', () => {
    const { container } = render(<PrivacyLoading />)

    expect(container.querySelectorAll('[data-slot="card"]')).toHaveLength(4)
    expect(container.querySelectorAll('.grid.gap-4').length).toBeGreaterThanOrEqual(1)
    expect(container.querySelectorAll('.grid.gap-4 > div')).toHaveLength(4)
    expect(screen.getAllByTestId('loading-skeleton-toggleRow')).toHaveLength(3)
    const cards = container.querySelectorAll('[data-slot="card"]')
    expect(cards[3]?.className).toContain('border-destructive/50')
  })

  it('does not keep the old three-section toggle grid', () => {
    const source = read('app/[locale]/(app)/settings/privacy/loading.tsx')

    expect(source).not.toContain("Schema.Literals(['section-1', 'section-2', 'section-3'])")
    expect(source).toContain('PrivacySettingsSkeleton')
  })
})
