import { describe, expect, it, vi } from 'vitest'

import { createMogThemeController, parseMogTheme } from '../../../../mog-sidecar/src/theme.js'

describe('MOG theme boundary', () => {
  it.each([
    null,
    {},
    { colorScheme: 'sepia', resolvedColorScheme: 'light' },
    { colorScheme: 'system', resolvedColorScheme: 'system' },
    { colorScheme: 'dark', resolvedColorScheme: 'light' },
  ])('rejects invalid host theme %j', (value) => {
    expect(parseMogTheme(value)).toBeNull()
  })

  it('updates UI chrome and boot surface, preserves canvas policy and ignores duplicate updates', () => {
    const render = vi.fn<() => void>()
    const controller = createMogThemeController(document, render)
    expect(controller.accept({ colorScheme: 'dark', resolvedColorScheme: 'dark' })).toBe(true)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(controller.policy()).toEqual({
      uiChrome: { colorScheme: 'dark', resolvedColorScheme: 'dark' },
    })
    controller.accept({ colorScheme: 'dark', resolvedColorScheme: 'dark' })
    expect(render).toHaveBeenCalledTimes(1)
    controller.accept({ colorScheme: 'system', resolvedColorScheme: 'light' })
    expect(controller.policy()).toEqual({
      uiChrome: { colorScheme: 'system', resolvedColorScheme: 'light' },
    })
    expect(document.documentElement.dataset.theme).toBe('light')
    controller.accept({ colorScheme: 'dark', resolvedColorScheme: 'light' })
    expect(render).toHaveBeenCalledTimes(2)
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})
