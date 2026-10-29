import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { NotificationBellFallback } from '@/components/layout/Navbar'

it('exposes the notifications control as busy while the bell loads', () => {
  render(<NotificationBellFallback />)
  const button = screen.getByRole('button', { name: 'Notificaciones' })
  expect(button).toBeDisabled()
  expect(button).toHaveAttribute('aria-busy', 'true')
  expect(button).not.toHaveAttribute('aria-hidden')
})
