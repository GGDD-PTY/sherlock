import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { render, screen } from '@testing-library/react'
import { NextIntlClientProvider } from 'next-intl'
import { describe, expect, it, vi } from 'vitest'

import NotificationsLoading from '@/app/[locale]/(app)/notifications/loading'
import esMessages from '@/messages/es.json'

vi.unmock('next-intl')

const source = readFileSync(
  join(process.cwd(), 'src/app/[locale]/(app)/notifications/loading.tsx'),
  'utf8'
)

describe('notifications loading copies the live page', () => {
  it('renders three equal tabs and a hairline list, not a wrapping card', () => {
    render(
      <NextIntlClientProvider locale="es" messages={esMessages}>
        <NotificationsLoading />
      </NextIntlClientProvider>
    )

    expect(screen.getByRole('heading', { name: 'Notificaciones' })).toHaveAttribute(
      'data-page-identity'
    )
    expect(document.querySelectorAll('.mt-4.mb-2.flex.w-full > *')).toHaveLength(3)
    expect(document.querySelector('[data-slot="card"]')).toBeNull()
    expect(source).not.toContain('CardHeader')
  })
})
