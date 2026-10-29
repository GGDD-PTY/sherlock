// ============================================================================
// E2E DRIVER: PLAYWRIGHT IMPLEMENTATION
// ============================================================================
// Thin wrapper around Playwright's Page API implementing IBrowserDriver.
// This is the default/fallback driver for E2E tests.
// ============================================================================

import type { Page, Locator } from '@playwright/test'
import type {
  IBrowserDriver,
  ElementRef,
  DriverConfig,
  ClickOptions,
  FillOptions,
  WaitOptions,
  ScreenshotOptions,
  SnapshotData,
  SnapshotElement,
} from './types'

// ============================================================================
// Accessibility tree (`page.ariaSnapshot`)
// ============================================================================

/** `- rol "nombre" [attr=valor]: texto` — un nodo del YAML de `ariaSnapshot()`. */
const ARIA_NODE_PATTERN =
  /^\s*-\s+([a-zA-Z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$/
const ARIA_ATTRIBUTE_PATTERN = /\[([\w-]+)(?:=([^\]]*))?\]/g

function unescapeAriaText(value: string): string {
  return value.replace(/\\(.)/g, '$1')
}

/** `[level=1]` → `1`; `[checked]` → `true`; `[checked=mixed]` → `'mixed'`. */
function parseAriaAttribute(value: string | undefined): unknown {
  if (value === undefined) return true
  if (value === 'true' || value === 'false') return value === 'true'
  const asNumber = Number(value)
  return value !== '' && !Number.isNaN(asNumber) ? asNumber : value
}

/**
 * Aplana el YAML de `page.ariaSnapshot()` en los elementos de `SnapshotData`.
 * Las líneas de propiedad (`- /url: …`) no son nodos y no empiezan con letra,
 * así que el patrón las descarta.
 */
function parseAriaSnapshot(raw: string): SnapshotElement[] {
  const elements: SnapshotElement[] = []
  const refCounts = new Map<string, number>()

  for (const line of raw.split('\n')) {
    const node = ARIA_NODE_PATTERN.exec(line)
    if (!node) continue

    // El grupo 1 siempre participa; los otros tres son opcionales, y `at()` los
    // devuelve como `string | undefined` en vez de mentir con `string`.
    const role = node[1]
    const quotedName = node.at(2)
    const attributes = node.at(3) ?? ''
    const trailing = node.at(4)
    const text = trailing ? unescapeAriaText(trailing) : undefined

    const count = refCounts.get(role) ?? 0
    refCounts.set(role, count + 1)

    const element: SnapshotElement = { ref: `@${role}[${count}]`, role }
    if (quotedName === undefined) {
      // Sin nombre accesible, el texto del nodo es su nombre; salvo en un
      // textbox, donde Playwright emite el valor del control (`- textbox: Acme`)
      // y `findElement` compara solo `name`, igual que el driver de agent-browser.
      if (text !== undefined) {
        if (role === 'textbox') element.value = text
        else element.name = text
      }
    } else {
      element.name = unescapeAriaText(quotedName)
      if (text !== undefined) element.value = text
    }

    const properties: Record<string, unknown> = {}
    for (const attribute of attributes.matchAll(ARIA_ATTRIBUTE_PATTERN)) {
      const key = attribute[1]
      if (key === 'disabled') {
        element.disabled = true
        continue
      }
      properties[key] = parseAriaAttribute(attribute.at(2))
    }
    if (Object.keys(properties).length > 0) element.properties = properties

    elements.push(element)
  }

  return elements
}

/**
 * Playwright-based browser driver implementation.
 * Provides a thin wrapper around Playwright's Page API.
 */
export class PlaywrightDriver implements IBrowserDriver {
  readonly driverType = 'playwright' as const

  private page: Page
  private config: DriverConfig

  constructor(page: Page, config: DriverConfig = {}) {
    this.page = page
    this.config = {
      timeout: 30000,
      ...config,
    }
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Resolve an ElementRef to a Playwright Locator.
   */
  private resolveLocator(element: ElementRef): Locator {
    const pw = element.playwright
    if (!pw) {
      throw new Error(`ElementRef has no Playwright data: ${JSON.stringify(element)}`)
    }

    let locator: Locator

    switch (pw.strategy) {
      case 'role': {
        const options: { name?: string | RegExp; exact?: boolean } = {}
        if (pw.options?.name) options.name = pw.options.name
        if (pw.options?.exact !== undefined) options.exact = pw.options.exact
        locator = this.page.getByRole(pw.value as Parameters<Page['getByRole']>[0], options)
        break
      }
      case 'text': {
        const textPattern = pw.regexFlags ? new RegExp(pw.value, pw.regexFlags) : pw.value
        locator = this.page.getByText(textPattern)
        break
      }
      case 'label': {
        const labelPattern = pw.regexFlags ? new RegExp(pw.value, pw.regexFlags) : pw.value
        locator = this.page.getByLabel(labelPattern)
        break
      }
      case 'placeholder': {
        const placeholderPattern = pw.regexFlags ? new RegExp(pw.value, pw.regexFlags) : pw.value
        locator = this.page.getByPlaceholder(placeholderPattern)
        break
      }
      case 'testId':
        locator = this.page.getByTestId(pw.value)
        break
      case 'selector':
      default:
        locator = this.page.locator(pw.value)
        break
    }

    // Apply modifiers
    const opts = pw.options as Record<string, unknown> | undefined
    if (opts?._first) {
      locator = locator.first()
    } else if (typeof opts?._nth === 'number') {
      locator = locator.nth(opts._nth as number)
    }

    return locator
  }

  /**
   * Create an ElementRef from locator strategy info.
   */
  private createRef(
    strategy: NonNullable<ElementRef['playwright']>['strategy'],
    value: string,
    options?: NonNullable<ElementRef['playwright']>['options'],
    regexFlags?: string
  ): ElementRef & { playwright: NonNullable<ElementRef['playwright']> } {
    return {
      playwright: { strategy, value, options, regexFlags },
      _debug: `${strategy}:${value}${regexFlags ? ` (flags: ${regexFlags})` : ''}`,
    }
  }

  // =========================================================================
  // Navigation
  // =========================================================================

  async goto(url: string): Promise<void> {
    const fullUrl = url.startsWith('http') || url.startsWith('/') ? url : `/${url}`
    await this.page.goto(fullUrl)
  }

  async goBack(): Promise<void> {
    await this.page.goBack()
  }

  async goForward(): Promise<void> {
    await this.page.goForward()
  }

  async reload(): Promise<void> {
    await this.page.reload()
  }

  async currentUrl(): Promise<string> {
    return this.page.url()
  }

  async title(): Promise<string> {
    return this.page.title()
  }

  // =========================================================================
  // Element Location
  // =========================================================================

  async getByRole(
    role: string,
    options?: { name?: string | RegExp; exact?: boolean }
  ): Promise<ElementRef> {
    return this.createRef('role', role, options)
  }

  async getByText(text: string | RegExp): Promise<ElementRef> {
    const value = text instanceof RegExp ? text.source : text
    const flags = text instanceof RegExp ? text.flags : undefined
    return this.createRef('text', value, undefined, flags)
  }

  async getByLabel(text: string | RegExp): Promise<ElementRef> {
    const value = text instanceof RegExp ? text.source : text
    const flags = text instanceof RegExp ? text.flags : undefined
    return this.createRef('label', value, undefined, flags)
  }

  async getByPlaceholder(text: string | RegExp): Promise<ElementRef> {
    const value = text instanceof RegExp ? text.source : text
    const flags = text instanceof RegExp ? text.flags : undefined
    return this.createRef('placeholder', value, undefined, flags)
  }

  async getByTestId(testId: string): Promise<ElementRef> {
    return this.createRef('testId', testId)
  }

  async locator(selector: string): Promise<ElementRef> {
    return this.createRef('selector', selector)
  }

  async first(element: ElementRef): Promise<ElementRef> {
    // Track that we want the first match
    const pw = element.playwright
    if (!pw) throw new Error('Invalid ElementRef')

    return {
      ...element,
      playwright: {
        ...pw,
        // Add a marker to indicate we want first()
        options: {
          ...pw.options,
          _first: true,
        } as NonNullable<ElementRef['playwright']>['options'],
      },
      _debug: `${element._debug}:first`,
    }
  }

  async nth(element: ElementRef, index: number): Promise<ElementRef> {
    const pw = element.playwright
    if (!pw) throw new Error('Invalid ElementRef')

    if (pw.strategy === 'selector') {
      return {
        ...element,
        playwright: {
          ...pw,
          value: `${pw.value}:nth-of-type(${index + 1})`,
        },
        _debug: `${element._debug}:nth(${index})`,
      }
    }

    return {
      ...element,
      playwright: {
        ...pw,
        options: {
          ...pw.options,
          _nth: index,
        },
      },
      _debug: `${element._debug}:nth(${index})`,
    }
  }

  // =========================================================================
  // Actions
  // =========================================================================

  async click(element: ElementRef, options?: ClickOptions): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.click({
      button: options?.button,
      clickCount: options?.clickCount,
      modifiers: options?.modifiers,
      force: options?.force,
      position: options?.position,
    })
  }

  async dblclick(element: ElementRef): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.dblclick()
  }

  async fill(element: ElementRef, value: string, _options?: FillOptions): Promise<void> {
    const locator = this.resolveLocator(element)
    const shouldClear = _options?.clear ?? true
    if (shouldClear) {
      await locator.fill(value)
    } else {
      await locator.focus()
      await locator.type(value)
    }
  }

  async type(element: ElementRef, value: string, options?: FillOptions): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.pressSequentially(value, { delay: options?.delay })
  }

  async clear(element: ElementRef): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.clear()
  }

  async press(key: string): Promise<void> {
    await this.page.keyboard.press(key)
  }

  async selectOption(element: ElementRef, value: string | string[]): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.selectOption(value)
  }

  async check(element: ElementRef): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.check()
  }

  async uncheck(element: ElementRef): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.uncheck()
  }

  async hover(element: ElementRef): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.hover()
  }

  async focus(element: ElementRef): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.focus()
  }

  // =========================================================================
  // State Queries
  // =========================================================================

  async isVisible(element: ElementRef): Promise<boolean> {
    try {
      const locator = this.resolveLocator(element)
      // Use first() to avoid strict mode violations when multiple elements match
      return await locator.first().isVisible()
    } catch {
      return false
    }
  }

  async isHidden(element: ElementRef): Promise<boolean> {
    try {
      const locator = this.resolveLocator(element)
      // Use first() to avoid strict mode violations when multiple elements match
      return await locator.first().isHidden()
    } catch {
      return true
    }
  }

  async isEnabled(element: ElementRef): Promise<boolean> {
    try {
      const locator = this.resolveLocator(element)
      // Use first() to avoid strict mode violations when multiple elements match
      return await locator.first().isEnabled()
    } catch {
      return false
    }
  }

  async isChecked(element: ElementRef): Promise<boolean> {
    try {
      const locator = this.resolveLocator(element)
      // Use first() to avoid strict mode violations when multiple elements match
      return await locator.first().isChecked()
    } catch {
      return false
    }
  }

  async getText(element: ElementRef): Promise<string> {
    const locator = this.resolveLocator(element)
    return (await locator.textContent()) ?? ''
  }

  async getValue(element: ElementRef): Promise<string> {
    const locator = this.resolveLocator(element)
    return await locator.inputValue()
  }

  async getAttribute(element: ElementRef, attribute: string): Promise<string | null> {
    const locator = this.resolveLocator(element)
    return await locator.getAttribute(attribute)
  }

  async count(element: ElementRef): Promise<number> {
    const locator = this.resolveLocator(element)
    return await locator.count()
  }

  // =========================================================================
  // Waiting
  // =========================================================================

  async waitForSelector(selector: string, options?: WaitOptions): Promise<ElementRef> {
    await this.page.waitForSelector(selector, {
      timeout: options?.timeout ?? this.config.timeout,
      state: options?.visible === false ? 'attached' : 'visible',
    })
    return this.createRef('selector', selector)
  }

  async waitForVisible(element: ElementRef, options?: WaitOptions): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.waitFor({
      state: 'visible',
      timeout: options?.timeout ?? this.config.timeout,
    })
  }

  async waitForHidden(element: ElementRef, options?: WaitOptions): Promise<void> {
    const locator = this.resolveLocator(element)
    await locator.waitFor({
      state: 'hidden',
      timeout: options?.timeout ?? this.config.timeout,
    })
  }

  async waitForUrl(pattern: string | RegExp, options?: WaitOptions): Promise<void> {
    await this.page.waitForURL(pattern, {
      timeout: options?.timeout ?? this.config.timeout,
    })
  }

  async waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    options?: WaitOptions
  ): Promise<void> {
    await this.page.waitForLoadState(state, {
      timeout: options?.timeout ?? this.config.timeout,
    })
  }

  async waitForTimeout(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms)
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    return await this.page.screenshot({
      path: options?.path,
      fullPage: options?.fullPage,
      type: options?.type,
      quality: options?.quality,
    })
  }

  async snapshot(): Promise<SnapshotData> {
    // `page.accessibility` salió de Playwright: no existe ni en los tipos ni en
    // el runtime de 1.61, así que la implementación anterior tiraba un
    // TypeError. El reemplazo publicado es `page.ariaSnapshot()`, que devuelve
    // el árbol como texto; se aplana con la misma convención de `@rol[n]` que
    // usa el driver de agent-browser para que los dos sean comparables.
    const raw = await this.page.ariaSnapshot()

    return {
      raw,
      elements: parseAriaSnapshot(raw),
      timestamp: Date.now(),
    }
  }

  async evaluate<T>(script: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
    if (typeof script === 'string') {
      return await this.page.evaluate(script)
    }
    return await this.page.evaluate(script, ...args)
  }

  async close(): Promise<void> {
    await this.page.close()
  }

  // =========================================================================
  // Internal Access (for advanced use cases)
  // =========================================================================

  /**
   * Get the underlying Playwright Page object.
   * Use sparingly - prefer the abstracted interface.
   */
  getPage(): Page {
    return this.page
  }
}
