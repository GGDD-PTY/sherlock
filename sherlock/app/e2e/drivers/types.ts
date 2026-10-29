// ============================================================================
// E2E DRIVER ABSTRACTION: TYPE DEFINITIONS
// ============================================================================
// Core interfaces for browser driver abstraction layer.
// Enables switching between Playwright (native) and agent-browser (CLI)
// via E2E_DRIVER environment variable.
// ============================================================================

/**
 * Element reference that can be resolved by either driver.
 * - Playwright uses locator strategies (role, text, CSS selector)
 * - agent-browser uses @ref identifiers from accessibility snapshots
 */
export interface ElementRef {
  /** Playwright-specific locator info */
  playwright?: {
    strategy: 'role' | 'text' | 'selector' | 'label' | 'placeholder' | 'testId'
    value: string
    /** RegExp flags when value originated from a RegExp (e.g., 'i' for case-insensitive) */
    regexFlags?: string
    options?: {
      name?: string | RegExp
      exact?: boolean
      level?: number
      /** Internal: nth-match index for element resolution */
      _nth?: number
      /** Internal: marker to indicate first() match */
      _first?: boolean
    }
  }

  /** agent-browser-specific reference info */
  agentBrowser?: {
    /** The @ref identifier (e.g., "@button[0]", "@link[3]") */
    ref: string
    /** Human-readable description for logging/debugging */
    description?: string
  }

  /** Original selector/description for debugging */
  _debug?: string
}

/**
 * Snapshot data from agent-browser accessibility tree.
 * Used to locate elements by their semantic properties.
 */
export interface SnapshotData {
  /** Raw snapshot text from agent-browser */
  raw: string

  /** Parsed elements from the snapshot */
  elements: SnapshotElement[]

  /** Timestamp when snapshot was taken */
  timestamp: number
}

/**
 * Individual element from an accessibility snapshot.
 */
export interface SnapshotElement {
  /** Reference identifier (e.g., "@button[0]") */
  ref: string

  /** Element role (button, link, textbox, etc.) */
  role: string

  /** Element name/label */
  name?: string

  /** Element value (for inputs) */
  value?: string

  /** Element description */
  description?: string

  /** Whether element is disabled */
  disabled?: boolean

  /** Whether element is hidden */
  hidden?: boolean

  /** Additional properties */
  properties?: Record<string, unknown>
}

/**
 * Configuration for creating a browser driver instance.
 */
export interface DriverConfig {
  /** Base URL for the application (e.g., http://localhost:3000) */
  baseURL?: string

  /** Default timeout in milliseconds */
  timeout?: number

  /** Whether to capture screenshots on failure */
  screenshotOnFailure?: boolean

  /** Viewport dimensions */
  viewport?: {
    width: number
    height: number
  }

  /** Headless mode (Playwright only) */
  headless?: boolean

  /** Slow motion delay in ms (for debugging) */
  slowMo?: number
}

/**
 * Options for waiting operations.
 */
export interface WaitOptions {
  /** Maximum time to wait in milliseconds */
  timeout?: number

  /** Wait for element to be visible (default: true) */
  visible?: boolean

  /** Wait for element to be enabled/not disabled */
  enabled?: boolean
}

/**
 * Options for fill/type operations.
 */
export interface FillOptions {
  /** Clear existing value before filling (default: true) */
  clear?: boolean

  /** Delay between keystrokes in ms (for type) */
  delay?: number
}

/**
 * Options for click operations.
 */
export interface ClickOptions {
  /** Mouse button (left, right, middle) */
  button?: 'left' | 'right' | 'middle'

  /** Number of clicks (1 = single, 2 = double) */
  clickCount?: number

  /** Modifier keys to hold during click */
  modifiers?: ('Alt' | 'Control' | 'Meta' | 'Shift')[]

  /** Force click even if element is obscured */
  force?: boolean

  /** Position within element to click */
  position?: { x: number; y: number }
}

/**
 * Options for screenshot operations.
 */
export interface ScreenshotOptions {
  /** Path to save screenshot */
  path?: string

  /** Capture full page (not just viewport) */
  fullPage?: boolean

  /** Image format */
  type?: 'png' | 'jpeg'

  /** Quality for JPEG (0-100) */
  quality?: number
}

/**
 * Unified browser driver interface.
 * Implemented by both PlaywrightDriver and AgentBrowserDriver.
 */
export interface IBrowserDriver {
  // =========================================================================
  // Navigation
  // =========================================================================

  /**
   * Navigate to a URL.
   * @param url - Full URL or path (relative to baseURL)
   */
  goto(url: string): Promise<void>

  /**
   * Navigate back in history.
   */
  goBack(): Promise<void>

  /**
   * Navigate forward in history.
   */
  goForward(): Promise<void>

  /**
   * Reload the current page.
   */
  reload(): Promise<void>

  /**
   * Get the current page URL.
   */
  currentUrl(): Promise<string>

  /**
   * Get the current page title.
   */
  title(): Promise<string>

  // =========================================================================
  // Element Location
  // =========================================================================

  /**
   * Find element by ARIA role.
   * @param role - ARIA role (button, link, textbox, etc.)
   * @param options - Additional options like name pattern
   */
  getByRole(
    role: string,
    options?: { name?: string | RegExp; exact?: boolean }
  ): Promise<ElementRef>

  /**
   * Find element by visible text content.
   * @param text - Text to match (string or regex)
   */
  getByText(text: string | RegExp): Promise<ElementRef>

  /**
   * Find element by label text (for form inputs).
   * @param text - Label text to match
   */
  getByLabel(text: string | RegExp): Promise<ElementRef>

  /**
   * Find element by placeholder text.
   * @param text - Placeholder text to match
   */
  getByPlaceholder(text: string | RegExp): Promise<ElementRef>

  /**
   * Find element by test ID attribute.
   * @param testId - data-testid value
   */
  getByTestId(testId: string): Promise<ElementRef>

  /**
   * Find element by CSS selector.
   * @param selector - CSS selector string
   */
  locator(selector: string): Promise<ElementRef>

  /**
   * Find first element matching criteria.
   * @param element - Element reference to get first match of
   */
  first(element: ElementRef): Promise<ElementRef>

  /**
   * Find nth element matching criteria.
   * @param element - Element reference
   * @param index - Zero-based index
   */
  nth(element: ElementRef, index: number): Promise<ElementRef>

  // =========================================================================
  // Actions
  // =========================================================================

  /**
   * Click on an element.
   * @param element - Element to click
   * @param options - Click options
   */
  click(element: ElementRef, options?: ClickOptions): Promise<void>

  /**
   * Double-click on an element.
   * @param element - Element to double-click
   */
  dblclick(element: ElementRef): Promise<void>

  /**
   * Fill a form field with a value (clears first).
   * @param element - Input element to fill
   * @param value - Value to fill
   * @param options - Fill options
   */
  fill(element: ElementRef, value: string, options?: FillOptions): Promise<void>

  /**
   * Type text into an element (key by key).
   * @param element - Element to type into
   * @param value - Text to type
   * @param options - Type options
   */
  type(element: ElementRef, value: string, options?: FillOptions): Promise<void>

  /**
   * Clear an input field.
   * @param element - Input element to clear
   */
  clear(element: ElementRef): Promise<void>

  /**
   * Press a keyboard key.
   * @param key - Key name (Enter, Tab, Escape, etc.)
   */
  press(key: string): Promise<void>

  /**
   * Select an option from a dropdown.
   * @param element - Select element
   * @param value - Option value or text
   */
  selectOption(element: ElementRef, value: string | string[]): Promise<void>

  /**
   * Check a checkbox or radio button.
   * @param element - Element to check
   */
  check(element: ElementRef): Promise<void>

  /**
   * Uncheck a checkbox.
   * @param element - Element to uncheck
   */
  uncheck(element: ElementRef): Promise<void>

  /**
   * Hover over an element.
   * @param element - Element to hover
   */
  hover(element: ElementRef): Promise<void>

  /**
   * Focus on an element.
   * @param element - Element to focus
   */
  focus(element: ElementRef): Promise<void>

  // =========================================================================
  // State Queries
  // =========================================================================

  /**
   * Check if element is visible on the page.
   * @param element - Element to check
   */
  isVisible(element: ElementRef): Promise<boolean>

  /**
   * Check if element is hidden.
   * @param element - Element to check
   */
  isHidden(element: ElementRef): Promise<boolean>

  /**
   * Check if element is enabled (not disabled).
   * @param element - Element to check
   */
  isEnabled(element: ElementRef): Promise<boolean>

  /**
   * Check if element is checked (checkbox/radio).
   * @param element - Element to check
   */
  isChecked(element: ElementRef): Promise<boolean>

  /**
   * Get text content of an element.
   * @param element - Element to get text from
   */
  getText(element: ElementRef): Promise<string>

  /**
   * Get value of an input element.
   * @param element - Input element
   */
  getValue(element: ElementRef): Promise<string>

  /**
   * Get an attribute value from an element.
   * @param element - Element to query
   * @param attribute - Attribute name
   */
  getAttribute(element: ElementRef, attribute: string): Promise<string | null>

  /**
   * Count elements matching a reference.
   * @param element - Element reference (may match multiple)
   */
  count(element: ElementRef): Promise<number>

  // =========================================================================
  // Waiting
  // =========================================================================

  /**
   * Wait for an element to appear.
   * @param selector - CSS selector or element ref
   * @param options - Wait options
   */
  waitForSelector(selector: string, options?: WaitOptions): Promise<ElementRef>

  /**
   * Wait for element to be visible.
   * @param element - Element to wait for
   * @param options - Wait options
   */
  waitForVisible(element: ElementRef, options?: WaitOptions): Promise<void>

  /**
   * Wait for element to be hidden.
   * @param element - Element to wait for
   * @param options - Wait options
   */
  waitForHidden(element: ElementRef, options?: WaitOptions): Promise<void>

  /**
   * Wait for URL to match pattern.
   * @param pattern - URL pattern (string or regex)
   * @param options - Wait options
   */
  waitForUrl(pattern: string | RegExp, options?: WaitOptions): Promise<void>

  /**
   * Wait for page to reach a load state.
   * @param state - Load state to wait for
   * @param options - Wait options
   */
  waitForLoadState(
    state: 'load' | 'domcontentloaded' | 'networkidle',
    options?: WaitOptions
  ): Promise<void>

  /**
   * Wait for a specific amount of time.
   * @param ms - Milliseconds to wait
   */
  waitForTimeout(ms: number): Promise<void>

  // =========================================================================
  // Utilities
  // =========================================================================

  /**
   * Take a screenshot.
   * @param options - Screenshot options
   * @returns Screenshot buffer
   */
  screenshot(options?: ScreenshotOptions): Promise<Buffer>

  /**
   * Take an accessibility snapshot.
   * @returns Snapshot data with parsed elements
   */
  snapshot(): Promise<SnapshotData>

  /**
   * Execute JavaScript in the page context.
   * @param script - Script to execute
   * @param args - Arguments to pass to script
   */
  evaluate<T>(script: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T>

  /**
   * Close the browser/driver.
   */
  close(): Promise<void>

  /**
   * Get the driver type.
   */
  readonly driverType: 'playwright' | 'agent-browser'
}

// ============================================================================
// Internal Types for Runtime Properties
// ============================================================================

/**
 * DOM Element extended with agent-browser runtime reference.
 * Used internally by AgentBrowserDriver for element tracking.
 */
export interface ElementWithAgentRef extends Element {
  /** Runtime reference assigned by agent-browser */
  _agentRef?: string
}

// ============================================================================
// Factory Types
// ============================================================================

/**
 * Driver type selection.
 */
export type DriverType = 'playwright' | 'agent-browser'

/**
 * Environment variable for driver selection.
 */
const E2E_DRIVER_ENV = 'E2E_DRIVER'

/**
 * Get the configured driver type from environment.
 */
export function getDriverType(): DriverType {
  const envValue = process.env[E2E_DRIVER_ENV]
  if (envValue === 'agent-browser') {
    return 'agent-browser'
  }
  return 'playwright' // Default fallback
}
