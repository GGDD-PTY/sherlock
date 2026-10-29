/** @typedef {Required<import('@mog-sdk/spreadsheet-app').MogSpreadsheetThemeAxis>} MogThemeAxis */

/**
 * @param {unknown} value
 * @returns {MogThemeAxis | null}
 */
export function parseMogTheme(value) {
  if (!value || typeof value !== 'object') return null
  if (!('colorScheme' in value) || !('resolvedColorScheme' in value)) return null
  const { colorScheme, resolvedColorScheme } = value
  if (colorScheme !== 'light' && colorScheme !== 'dark' && colorScheme !== 'system') return null
  if (resolvedColorScheme !== 'light' && resolvedColorScheme !== 'dark') return null
  if (colorScheme !== 'system' && colorScheme !== resolvedColorScheme) return null
  return { colorScheme, resolvedColorScheme }
}

/**
 * @param {Document} document
 * @param {() => void} render
 */
export function createMogThemeController(document, render) {
  /** @type {MogThemeAxis} */
  let current = { colorScheme: 'light', resolvedColorScheme: 'light' }
  return {
    policy: () => ({ uiChrome: current }),
    /** @param {unknown} value */
    accept(value) {
      const next = parseMogTheme(value)
      if (!next) return false
      document.documentElement.dataset.theme = next.resolvedColorScheme
      document.documentElement.style.colorScheme = next.resolvedColorScheme
      if (
        next.colorScheme === current.colorScheme &&
        next.resolvedColorScheme === current.resolvedColorScheme
      )
        return true
      current = next
      render()
      return true
    },
  }
}
