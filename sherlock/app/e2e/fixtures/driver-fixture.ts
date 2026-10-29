// ============================================================================
// E2E FIXTURE: BROWSER DRIVER
// ============================================================================
// Playwright test fixture that provides a unified `driver` object.
// Auto-selects driver based on E2E_DRIVER environment variable.
//
// Usage:
//   import { test, expect } from '../fixtures/driver-fixture';
//
//   test('example', async ({ driver }) => {
//     await driver.goto('/');
//     const button = await driver.getByRole('button', { name: 'Submit' });
//     expect(await driver.isVisible(button)).toBe(true);
//   });
// ============================================================================

/* eslint-disable react-hooks/rules-of-hooks */
// Note: The `use` function below is Playwright's fixture function, not a React hook.
// ESLint incorrectly flags it as a React hook violation.

import { test as base, expect } from '@playwright/test'
import type { IBrowserDriver, DriverConfig } from '../drivers/types'
import { getDriverType } from '../drivers/types'
import { createDriver } from '../drivers/driver-factory'
import { AgentBrowserDriver } from '../drivers/agent-browser-driver'
import { emitReliabilityEvent } from '../drivers/reliability-events'

const DEFAULT_BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000'

/**
 * Extended test fixtures including the unified browser driver.
 */
export interface DriverFixtures {
  /**
   * Unified browser driver that works with both Playwright and agent-browser.
   * The driver type is determined by the E2E_DRIVER environment variable.
   */
  driver: IBrowserDriver

  /**
   * Driver configuration options.
   * Override in test.use() to customize driver behavior.
   */
  driverConfig: DriverConfig
}

/**
 * Extended Playwright test with driver fixture.
 *
 * @example
 * ```typescript
 * import { test, expect } from '../fixtures/driver-fixture';
 *
 * test('landing page loads', async ({ driver }) => {
 *   await driver.goto('/');
 *   const title = await driver.title();
 *   expect(title).toContain('Sherlock');
 * });
 * ```
 */
export const test = base.extend<DriverFixtures>({
  // Default driver configuration
  driverConfig: [
    {
      baseURL: DEFAULT_BASE_URL,
      timeout: 30000,
      viewport: { width: 1280, height: 720 },
    },
    { option: true },
  ],

  // Driver fixture - automatically created and cleaned up
  driver: async ({ page, driverConfig }, use) => {
    const driverType = getDriverType()
    let driver: IBrowserDriver

    if (driverType === 'agent-browser') {
      // Create agent-browser driver (doesn't use Playwright page)
      driver = new AgentBrowserDriver(driverConfig)

      emitReliabilityEvent('fixture.driver.create', 'info', {
        driver_type: driverType,
      })

      // Initialize the browser session
      await (driver as AgentBrowserDriver).initialize()
    } else {
      emitReliabilityEvent('fixture.driver.create', 'info', {
        driver_type: driverType,
      })
      // Create Playwright driver wrapper
      driver = createDriver(page, driverConfig)
    }

    // Provide driver to test
    await use(driver)

    // Cleanup after test
    if (driverType === 'agent-browser') {
      try {
        await driver.close()
      } finally {
        emitReliabilityEvent('fixture.driver.cleanup', 'info', {
          driver_type: driverType,
        })
      }
    } else {
      emitReliabilityEvent('fixture.driver.cleanup', 'info', {
        driver_type: driverType,
      })
    }
    // Playwright driver cleanup is handled by Playwright's page fixture
  },
})

/**
 * Re-export expect for convenience.
 */
export { expect }
