// ============================================================================
// E2E DRIVER: FACTORY
// ============================================================================
// Factory function to create the appropriate browser driver based on
// environment configuration.
//
// Usage:
//   E2E_DRIVER=playwright bun run test:e2e  # Use Playwright (default)
//   E2E_DRIVER=agent-browser bun run test:e2e  # Use agent-browser
//
// Import Strategy:
// - Factory functions: import from './driver-factory'
// - Types: import from './types'; each driver class from its own module
//   ('./playwright-driver', './agent-browser-driver'). There is no barrel.
// ============================================================================

import type { Page } from '@playwright/test'
import type { IBrowserDriver, DriverConfig } from './types'
import { getDriverType } from './types'
import { PlaywrightDriver } from './playwright-driver'
import { AgentBrowserDriver } from './agent-browser-driver'

/**
 * Create a browser driver instance based on environment configuration.
 *
 * @param page - Playwright Page object (required for Playwright driver, optional for agent-browser)
 * @param config - Driver configuration options
 * @returns IBrowserDriver instance
 *
 * @example
 * ```typescript
 * // In a Playwright test
 * test('example', async ({ page }) => {
 *   const driver = createDriver(page);
 *   await driver.goto('/');
 *   const button = await driver.getByRole('button', { name: 'Submit' });
 *   await driver.click(button);
 * });
 * ```
 */
export function createDriver(page?: Page, config: DriverConfig = {}): IBrowserDriver {
  const driverType = getDriverType()

  if (driverType === 'agent-browser') {
    return new AgentBrowserDriver(config)
  }

  if (!page) {
    throw new Error('Page is required when using Playwright driver')
  }

  return new PlaywrightDriver(page, config)
}

// ============================================================================
// Factory Functions Only
// ============================================================================
// This file exports only factory functions.
// For types, import from ./types; for a driver class, from its own module.
