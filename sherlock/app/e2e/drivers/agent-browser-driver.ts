// ============================================================================
// E2E DRIVER: AGENT-BROWSER IMPLEMENTATION
// ============================================================================
// IBrowserDriver implementation using agent-browser CLI.
// Wraps the CLI helper to provide a unified driver interface.
// ============================================================================

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
  ElementWithAgentRef,
} from './types'
import { AgentBrowserCLI, type AgentBrowserCLIConfig } from './agent-browser-cli'
import {
  createManagedCloudSession,
  getAgentBrowserMode,
  isStrictCloudMode,
  type ManagedCloudSession,
} from './cloud-session'
import { emitReliabilityEvent } from './reliability-events'

const DEFAULT_BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

/**
 * Agent-browser-based browser driver implementation.
 * Uses CLI commands to control the browser.
 */
export class AgentBrowserDriver implements IBrowserDriver {
  readonly driverType = 'agent-browser' as const

  private cli: AgentBrowserCLI
  private config: DriverConfig
  private baseURL: string
  private managedCloudSession: ManagedCloudSession | null = null
  private initialized = false

  /** Cached snapshot for element resolution */
  private snapshotCache: SnapshotData | null = null
  private snapshotCacheTime = 0
  private readonly snapshotCacheTTL = 500 // ms

  constructor(config: DriverConfig = {}) {
    this.config = {
      baseURL: DEFAULT_BASE_URL,
      timeout: 30000,
      headless: true,
      viewport: { width: 1280, height: 720 },
      ...config,
    }

    this.baseURL = this.config.baseURL ?? DEFAULT_BASE_URL

    const explicitEndpoint = process.env.E2E_AGENT_BROWSER_WS_ENDPOINT?.trim()
    const cliConfig: AgentBrowserCLIConfig = {
      timeout: this.config.timeout,
      headless: this.config.headless,
      viewport: this.config.viewport,
      debug: process.env.DEBUG_AGENT_BROWSER === 'true',
      wsEndpoint: explicitEndpoint || undefined,
    }

    this.cli = new AgentBrowserCLI(cliConfig)
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * Initialize the browser session.
   * Must be called before any other operations.
   */
  async initialize(): Promise<void> {
    if (this.initialized && this.cli.hasSession()) {
      return
    }

    if (this.cli.hasSession()) {
      this.initialized = true
      return
    }

    const mode = getAgentBrowserMode()
    const cloudOptions = {
      headless: this.config.headless,
      timeoutMs: this.config.timeout,
      viewport: this.config.viewport,
    }

    try {
      const managed = await createManagedCloudSession(mode, cloudOptions)
      if (managed) {
        this.managedCloudSession = managed
        this.cli.setEndpoint(managed.wsEndpoint)
        this.initialized = true
        emitReliabilityEvent('driver.agent_browser.bootstrap.cloud_success', 'info', {
          mode,
          provider: managed.provider,
          session_id: managed.sessionId,
          has_live_view: Boolean(managed.liveViewUrl),
        })
        return
      }
    } catch (error) {
      emitReliabilityEvent('driver.agent_browser.bootstrap.cloud_failed', 'warn', {
        mode,
        error: error instanceof Error ? error.message : String(error),
      })

      if (isStrictCloudMode(mode)) {
        throw error
      }

      emitReliabilityEvent('driver.agent_browser.bootstrap.fallback_local', 'info', {
        mode,
      })
    }

    if (!this.cli.hasSession()) {
      await this.cli.startSession()
      emitReliabilityEvent('driver.agent_browser.bootstrap.local_success', 'info', {
        mode,
      })
    }

    this.initialized = true
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Get a fresh snapshot, using cache if valid.
   */
  private async getSnapshot(forceRefresh = false): Promise<SnapshotData> {
    const now = Date.now()

    if (
      !forceRefresh &&
      this.snapshotCache &&
      now - this.snapshotCacheTime < this.snapshotCacheTTL
    ) {
      return this.snapshotCache
    }

    const result = await this.cli.snapshot()
    if (!result.success || !result.snapshot) {
      throw new Error(`Failed to get snapshot: ${result.error}`)
    }

    this.snapshotCache = result.snapshot
    this.snapshotCacheTime = now

    return result.snapshot
  }

  /**
   * Invalidate the snapshot cache.
   * Call after actions that modify the DOM.
   */
  private invalidateCache(): void {
    this.snapshotCache = null
    this.snapshotCacheTime = 0
  }

  /**
   * Resolve an ElementRef to an agent-browser @ref.
   * Takes a fresh snapshot and finds the matching element.
   */
  private async resolveRef(element: ElementRef): Promise<string> {
    // If we already have a resolved ref, use it
    if (element.agentBrowser?.ref) {
      return element.agentBrowser.ref
    }

    // Get fresh snapshot
    const snapshot = await this.getSnapshot(true)

    // Resolve based on stored criteria
    const pw = element.playwright
    if (!pw) {
      throw new Error(`Cannot resolve ElementRef: ${JSON.stringify(element)}`)
    }

    let found: SnapshotElement | null = null
    const nthIndex = pw.options?._nth ?? 0

    switch (pw.strategy) {
      case 'role': {
        const elements = this.cli.findElements(snapshot, pw.value, {
          name: pw.options?.name,
          exact: pw.options?.exact,
        })
        found = elements[nthIndex] || null
        break
      }

      case 'text': {
        // Reconstruct RegExp if we have flags, otherwise use string matching
        const textMatcher = pw.regexFlags
          ? (content: string) => new RegExp(pw.value, pw.regexFlags).test(content)
          : (content: string) => content.toLowerCase().includes(pw.value.toLowerCase())
        const elements = snapshot.elements.filter((el) => {
          const content = el.name || el.value || ''
          return textMatcher(content)
        })
        found = elements[nthIndex] || null
        break
      }

      case 'label': {
        // Find input associated with label
        // First find the label, then look for nearby input
        const labelMatcher = pw.regexFlags
          ? (content: string) => new RegExp(pw.value, pw.regexFlags).test(content)
          : (content: string) => content.toLowerCase().includes(pw.value.toLowerCase())
        const labelElements = snapshot.elements.filter((el) => {
          const content = el.name || el.value || ''
          return labelMatcher(content)
        })
        const labelFound = labelElements[nthIndex]
        if (labelFound && labelFound.role === 'text') {
          // It's the label text, look for the input
          const inputs = this.cli.findElements(snapshot, 'textbox')
          // Find first textbox that appears after the label (heuristic)
          if (inputs.length > 0) {
            found = inputs[0]
          }
        } else {
          found = labelFound || null
        }
        break
      }

      case 'placeholder': {
        // Find input with matching placeholder
        const placeholderMatcher = pw.regexFlags
          ? (content: string) => new RegExp(pw.value, pw.regexFlags).test(content)
          : (content: string) => content.toLowerCase().includes(pw.value.toLowerCase())
        const placeholderElements = snapshot.elements.filter(
          (el) => el.role === 'textbox' && el.name && placeholderMatcher(el.name)
        )
        found = placeholderElements[nthIndex] || null
        break
      }

      case 'testId':
        // agent-browser may not expose data-testid directly
        // Fall back to searching by name containing the testId
        const testIdElements = snapshot.elements.filter(
          (el) => el.name?.includes(pw.value) || el.description?.includes(pw.value)
        )
        found = testIdElements[nthIndex] || null
        break

      case 'selector':
        // CSS selectors need to be mapped to semantic queries
        // This is a best-effort heuristic
        if (pw.value.startsWith('#')) {
          // ID selector - search by name
          const id = pw.value.slice(1)
          found = this.cli.findByText(snapshot, id)
        } else if (pw.value.includes('[data-testid=')) {
          // Extract testid
          const match = pw.value.match(/\[data-testid=["']?([^"'\]]+)["']?\]/)
          if (match) {
            const elements = snapshot.elements.filter(
              (el) => el.name?.includes(match[1]) || el.description?.includes(match[1])
            )
            found = elements[nthIndex] || null
          }
        } else {
          // Generic selector - try to find by role implied in selector
          const roleMatch = pw.value.match(
            /\b(button|link|heading|textbox|checkbox|radio|combobox|menu|dialog)\b/i
          )
          if (roleMatch) {
            const elements = this.cli.findElements(snapshot, roleMatch[1])
            found = elements[nthIndex] || null
          }
        }
        break
    }

    if (!found) {
      throw new Error(`Element not found: ${element._debug || JSON.stringify(element)}`)
    }

    return found.ref
  }

  /**
   * Create an ElementRef with resolution criteria.
   */
  private createRef(
    strategy: NonNullable<ElementRef['playwright']>['strategy'],
    value: string,
    options?: NonNullable<ElementRef['playwright']>['options'],
    regexFlags?: string
  ): ElementRef {
    return {
      playwright: { strategy, value, options, regexFlags },
      _debug: `${strategy}:${value}${regexFlags ? ` (flags: ${regexFlags})` : ''}`,
    }
  }

  /**
   * Execute a CLI command that may fail and throw appropriate error.
   */
  private async executeOrThrow(
    action: string,
    executor: () => Promise<{ success: boolean; error?: string }>
  ): Promise<void> {
    const result = await executor()
    if (!result.success) {
      throw new Error(`${action} failed: ${result.error}`)
    }
    this.invalidateCache()
  }

  // =========================================================================
  // Navigation
  // =========================================================================

  async goto(url: string): Promise<void> {
    await this.initialize()

    let fullUrl: string
    if (url.startsWith('http')) {
      fullUrl = url
    } else if (url.startsWith('/')) {
      fullUrl = `${this.baseURL}${url}`
    } else {
      fullUrl = `${this.baseURL}/${url}`
    }

    await this.executeOrThrow('Navigate', () => this.cli.navigate(fullUrl))
  }

  async goBack(): Promise<void> {
    await this.executeOrThrow('GoBack', () => this.cli.goBack())
  }

  async goForward(): Promise<void> {
    await this.executeOrThrow('GoForward', () => this.cli.goForward())
  }

  async reload(): Promise<void> {
    await this.executeOrThrow('Reload', () => this.cli.reload())
  }

  async currentUrl(): Promise<string> {
    await this.initialize()
    return this.cli.getCurrentUrl()
  }

  async title(): Promise<string> {
    await this.initialize()
    return this.cli.getTitle()
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
    // For agent-browser, we'll resolve and take the first match
    return {
      ...element,
      _debug: `${element._debug}:first`,
    }
  }

  async nth(element: ElementRef, index: number): Promise<ElementRef> {
    // Store index for later resolution
    return {
      ...element,
      playwright: element.playwright
        ? {
            ...element.playwright,
            options: {
              ...element.playwright.options,
              // Store index in options for resolution
              _nth: index,
            },
          }
        : undefined,
      _debug: `${element._debug}:nth(${index})`,
    }
  }

  // =========================================================================
  // Actions
  // =========================================================================

  async click(element: ElementRef, _unusedOptions?: ClickOptions): Promise<void> {
    await this.initialize()
    const ref = await this.resolveRef(element)
    await this.executeOrThrow('Click', () => this.cli.click(ref))
  }

  async dblclick(element: ElementRef): Promise<void> {
    await this.initialize()
    const ref = await this.resolveRef(element)

    // Dispatch a real MouseEvent('dblclick') on the element
    // UI listeners for native 'dblclick' will be triggered
    await this.evaluate((r) => {
      const el =
        document.querySelector(`[data-agent-ref="${r}"]`) ||
        Array.from(document.querySelectorAll('*')).find(
          (e) => (e as ElementWithAgentRef)._agentRef === r
        )
      if (el) {
        el.dispatchEvent(
          new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window })
        )
      }
    }, ref)
    this.invalidateCache()
  }

  async fill(element: ElementRef, value: string, _unusedOptions?: FillOptions): Promise<void> {
    await this.initialize()
    const ref = await this.resolveRef(element)
    await this.executeOrThrow('Fill', () => this.cli.fill(ref, value))
  }

  async type(element: ElementRef, value: string, _unusedOptions?: FillOptions): Promise<void> {
    await this.initialize()
    const ref = await this.resolveRef(element)
    await this.executeOrThrow('Type', () => this.cli.type(ref, value))
  }

  async clear(element: ElementRef): Promise<void> {
    await this.fill(element, '')
  }

  async press(key: string): Promise<void> {
    await this.initialize()
    await this.executeOrThrow('Press', () => this.cli.pressKey(key))
  }

  async selectOption(element: ElementRef, value: string | string[]): Promise<void> {
    await this.initialize()
    const ref = await this.resolveRef(element)
    const val = Array.isArray(value) ? value[0] : value
    await this.executeOrThrow('Select', () => this.cli.selectOption(ref, val))
  }

  async check(element: ElementRef): Promise<void> {
    const checked = await this.isChecked(element)
    if (!checked) {
      await this.click(element)
    }
  }

  async uncheck(element: ElementRef): Promise<void> {
    const checked = await this.isChecked(element)
    if (checked) {
      await this.click(element)
    }
  }

  async hover(element: ElementRef): Promise<void> {
    await this.initialize()
    const ref = await this.resolveRef(element)
    await this.executeOrThrow('Hover', () => this.cli.hover(ref))
  }

  async focus(element: ElementRef): Promise<void> {
    await this.click(element)
  }

  // =========================================================================
  // State Queries
  // =========================================================================

  async isVisible(element: ElementRef): Promise<boolean> {
    try {
      await this.initialize()
      const snapshot = await this.getSnapshot(true)

      const pw = element.playwright
      if (!pw) return false

      let found: SnapshotElement | null = null

      switch (pw.strategy) {
        case 'role':
          found = this.cli.findElement(snapshot, pw.value, {
            name: pw.options?.name,
            exact: pw.options?.exact,
          })
          break
        case 'text':
          found = this.cli.findByText(snapshot, pw.value)
          break
        default:
          // Try generic resolution
          try {
            await this.resolveRef(element)
            return true
          } catch {
            return false
          }
      }

      return found !== null && !found.hidden
    } catch {
      return false
    }
  }

  async isHidden(element: ElementRef): Promise<boolean> {
    return !(await this.isVisible(element))
  }

  async isEnabled(element: ElementRef): Promise<boolean> {
    try {
      await this.initialize()
      const snapshot = await this.getSnapshot(true)
      const ref = await this.resolveRef(element)

      const found = snapshot.elements.find((el) => el.ref === ref)
      return found !== null && !found?.disabled
    } catch {
      return false
    }
  }

  async isChecked(element: ElementRef): Promise<boolean> {
    try {
      await this.initialize()
      const snapshot = await this.getSnapshot(true)
      const ref = await this.resolveRef(element)

      const found = snapshot.elements.find((el) => el.ref === ref)
      return found?.properties?.checked === true
    } catch {
      return false
    }
  }

  async getText(element: ElementRef): Promise<string> {
    await this.initialize()
    const snapshot = await this.getSnapshot(true)
    const ref = await this.resolveRef(element)

    const found = snapshot.elements.find((el) => el.ref === ref)
    return found?.name || found?.value || ''
  }

  async getValue(element: ElementRef): Promise<string> {
    await this.initialize()
    const snapshot = await this.getSnapshot(true)
    const ref = await this.resolveRef(element)

    const found = snapshot.elements.find((el) => el.ref === ref)
    return found?.value || ''
  }

  async getAttribute(element: ElementRef, attribute: string): Promise<string | null> {
    await this.initialize()
    const snapshot = await this.getSnapshot(true)
    const ref = await this.resolveRef(element)

    const found = snapshot.elements.find((el) => el.ref === ref)
    if (!found) return null

    // Check common attributes
    if (attribute === 'name') return found.name || null
    if (attribute === 'value') return found.value || null
    if (attribute === 'role') return found.role

    // Check properties
    const propValue = found.properties?.[attribute]
    return propValue !== undefined ? String(propValue) : null
  }

  async count(element: ElementRef): Promise<number> {
    try {
      await this.initialize()
      const snapshot = await this.getSnapshot(true)

      const pw = element.playwright
      if (!pw) return 0

      if (pw.strategy === 'role') {
        const elements = this.cli.findElements(snapshot, pw.value, {
          name: pw.options?.name,
          exact: pw.options?.exact,
        })
        return elements.length
      }

      // For other strategies, attempt count by finding all matches
      // This is approximate
      return (await this.isVisible(element)) ? 1 : 0
    } catch {
      return 0
    }
  }

  // =========================================================================
  // Waiting
  // =========================================================================

  async waitForSelector(selector: string, options?: WaitOptions): Promise<ElementRef> {
    await this.initialize()
    const timeout = options?.timeout ?? this.config.timeout ?? 30000
    const startTime = Date.now()

    const ref = this.createRef('selector', selector)

    while (Date.now() - startTime < timeout) {
      if (await this.isVisible(ref)) {
        return ref
      }
      await this.waitForTimeout(100)
    }

    throw new Error(`Timeout waiting for selector: ${selector}`)
  }

  async waitForVisible(element: ElementRef, options?: WaitOptions): Promise<void> {
    await this.initialize()
    const timeout = options?.timeout ?? this.config.timeout ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (await this.isVisible(element)) {
        return
      }
      await this.waitForTimeout(100)
    }

    throw new Error(`Timeout waiting for element: ${element._debug}`)
  }

  async waitForHidden(element: ElementRef, options?: WaitOptions): Promise<void> {
    await this.initialize()
    const timeout = options?.timeout ?? this.config.timeout ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      if (await this.isHidden(element)) {
        return
      }
      await this.waitForTimeout(100)
    }

    throw new Error(`Timeout waiting for element to hide: ${element._debug}`)
  }

  async waitForUrl(pattern: string | RegExp, options?: WaitOptions): Promise<void> {
    await this.initialize()
    const timeout = options?.timeout ?? this.config.timeout ?? 30000
    const startTime = Date.now()

    while (Date.now() - startTime < timeout) {
      const url = await this.currentUrl()

      if (typeof pattern === 'string') {
        if (url.includes(pattern)) return
      } else {
        if (pattern.test(url)) return
      }

      await this.waitForTimeout(100)
    }

    throw new Error(`Timeout waiting for URL: ${pattern}`)
  }

  async waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    options?: WaitOptions
  ): Promise<void> {
    await this.initialize()
    const timeout = options?.timeout ?? this.config.timeout ?? 30000
    const delay = state === 'networkidle' ? Math.min(timeout, 1000) : Math.min(timeout, 300)
    await this.waitForTimeout(delay)
  }

  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    await this.initialize()
    const result = await this.cli.screenshot(options?.path)

    if (!result.success) {
      throw new Error(`Screenshot failed: ${result.error}`)
    }

    // If path was provided, return empty buffer (file was saved)
    if (options?.path) {
      return Buffer.from([])
    }

    // Return the screenshot data (base64 encoded in stdout)
    return Buffer.from(result.stdout, 'base64')
  }

  async snapshot(): Promise<SnapshotData> {
    await this.initialize()
    return this.getSnapshot(true)
  }

  async evaluate<T>(
    script: string | ((...args: unknown[]) => T),
    ..._unusedArgs: unknown[]
  ): Promise<T> {
    await this.initialize()

    const scriptStr = typeof script === 'function' ? `(${script.toString()})()` : script

    const result = await this.cli.evaluate(scriptStr)

    if (!result.success) {
      throw new Error(`Evaluate failed: ${result.error}`)
    }

    try {
      return JSON.parse(result.stdout) as T
    } catch {
      return result.stdout as unknown as T
    }
  }

  async close(): Promise<void> {
    const closeErrors: string[] = []

    if (this.managedCloudSession?.provider === 'remote-ws') {
      this.cli.clearEndpoint()
    } else {
      try {
        await this.cli.closeSession()
      } catch (error) {
        closeErrors.push(`cli-close: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (this.managedCloudSession) {
      try {
        await this.managedCloudSession.close()
      } catch (error) {
        closeErrors.push(
          `cloud-close(${this.managedCloudSession.provider}): ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      } finally {
        this.managedCloudSession = null
      }
    }

    this.initialized = false

    if (closeErrors.length > 0) {
      emitReliabilityEvent('driver.agent_browser.close.partial_failure', 'warn', {
        errors: closeErrors,
      })
      throw new Error(closeErrors.join('; '))
    }

    emitReliabilityEvent('driver.agent_browser.close.success', 'info')
  }
}
