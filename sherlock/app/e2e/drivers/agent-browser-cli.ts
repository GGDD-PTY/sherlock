// ============================================================================
// E2E DRIVER: AGENT-BROWSER CLI HELPER
// ============================================================================
// Low-level CLI execution helper for agent-browser.
// Handles spawning commands, parsing output, and session management.
// ============================================================================

import { spawn } from 'child_process'
import type { SnapshotData, SnapshotElement } from './types'
import { emitReliabilityEvent } from './reliability-events'

/**
 * Result of executing an agent-browser command.
 */
export interface AgentBrowserResult {
  /** Whether the command succeeded */
  success: boolean

  /** Stdout output */
  stdout: string

  /** Stderr output */
  stderr: string

  /** Exit code */
  exitCode: number | null

  /** Parsed snapshot data (if applicable) */
  snapshot?: SnapshotData

  /** Error message if failed */
  error?: string
}

/**
 * Configuration for agent-browser CLI.
 */
export interface AgentBrowserCLIConfig {
  /** Path to agent-browser binary (default: "agent-browser") */
  binaryPath?: string

  /** WebSocket endpoint for persistent session */
  wsEndpoint?: string

  /** Session namespace for CLI persistence */
  sessionName?: string

  /** Default timeout in ms */
  timeout?: number

  /** Enable debug logging */
  debug?: boolean

  /** Browser type (default: chromium) */
  browser?: 'chromium' | 'firefox' | 'webkit'

  /** Run in headless mode (default: true) */
  headless?: boolean

  /** Viewport dimensions */
  viewport?: { width: number; height: number }
}

/**
 * Agent-browser CLI wrapper for executing browser commands.
 */
export class AgentBrowserCLI {
  private config: Required<AgentBrowserCLIConfig>
  private wsEndpoint: string | null = null
  private cdpPort: number | null = null

  constructor(config: AgentBrowserCLIConfig = {}) {
    this.config = {
      binaryPath: config.binaryPath ?? 'agent-browser',
      wsEndpoint: config.wsEndpoint ?? '',
      sessionName: config.sessionName ?? process.env.AGENT_BROWSER_SESSION ?? 'sherlock-e2e',
      timeout: config.timeout ?? 30000,
      debug: config.debug ?? false,
      browser: config.browser ?? 'chromium',
      headless: config.headless ?? true,
      viewport: config.viewport ?? { width: 1280, height: 720 },
    }

    if (config.wsEndpoint) {
      this.wsEndpoint = config.wsEndpoint
      this.cdpPort = this.parseCDPPort(config.wsEndpoint)
    }
  }

  private parseCDPPort(endpoint: string): number | null {
    try {
      const url = new URL(endpoint)
      const parsed = Number(url.port)
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed
      }
      return null
    } catch {
      return null
    }
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * Start a persistent browser session.
   * Returns the WebSocket endpoint for connecting to it.
   */
  async startSession(): Promise<string> {
    if (this.wsEndpoint) {
      emitReliabilityEvent('driver.agent_browser.session.reuse', 'info', {
        endpoint_prefix: this.wsEndpoint.slice(0, 32),
      })
      return this.wsEndpoint
    }

    // Newer agent-browser CLI starts session lazily by command.
    this.wsEndpoint = `session:${this.config.sessionName}`
    emitReliabilityEvent('driver.agent_browser.session.ready', 'info', {
      session: this.config.sessionName,
      cdp_port: this.cdpPort ?? undefined,
    })
    return this.wsEndpoint
  }

  /**
   * Close the browser session.
   */
  async closeSession(): Promise<void> {
    if (!this.wsEndpoint) {
      return
    }

    try {
      await this.execute(['close'])
      emitReliabilityEvent('driver.agent_browser.session.close_success', 'info', {
        endpoint_prefix: this.wsEndpoint.slice(0, 32),
      })
    } catch {
      // Ignore errors on close
      emitReliabilityEvent('driver.agent_browser.session.close_failed', 'warn', {
        endpoint_prefix: this.wsEndpoint.slice(0, 32),
      })
    }

    this.wsEndpoint = null
  }

  /**
   * Check if session is active.
   */
  hasSession(): boolean {
    return this.wsEndpoint !== null
  }

  /**
   * Get current WebSocket endpoint.
   */
  getEndpoint(): string | null {
    return this.wsEndpoint
  }

  /**
   * Inject a pre-existing endpoint (for cloud-managed sessions).
   */
  setEndpoint(endpoint: string): void {
    this.wsEndpoint = endpoint
    this.cdpPort = this.parseCDPPort(endpoint)
    emitReliabilityEvent('driver.agent_browser.session.endpoint_set', 'info', {
      endpoint_prefix: endpoint.slice(0, 32),
      cdp_port: this.cdpPort ?? undefined,
    })
  }

  /**
   * Clear current endpoint without sending close command.
   */
  clearEndpoint(): void {
    this.wsEndpoint = null
    this.cdpPort = null
    emitReliabilityEvent('driver.agent_browser.session.endpoint_cleared', 'info')
  }

  // =========================================================================
  // Command Execution
  // =========================================================================

  /**
   * Execute an agent-browser command.
   */
  async execute(args: string[]): Promise<AgentBrowserResult> {
    return new Promise((resolve) => {
      const startTime = Date.now()
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let killTimeout: NodeJS.Timeout | undefined

      const finalArgs: string[] = ['--session', this.config.sessionName]
      if (this.cdpPort !== null) {
        finalArgs.push('--cdp', String(this.cdpPort))
      }
      finalArgs.push(...args)

      if (this.config.debug) {
        console.log(`[agent-browser] ${this.config.binaryPath} ${finalArgs.join(' ')}`)
      }

      const child = spawn(this.config.binaryPath, finalArgs, {
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      const timeout = setTimeout(() => {
        timedOut = true
        if (child.pid) {
          child.kill('SIGTERM')
          // Set fallback timer to send SIGKILL if process doesn't exit
          killTimeout = setTimeout(() => {
            try {
              // Check if process is still running before sending SIGKILL
              if (child.pid && !child.killed) {
                child.kill('SIGKILL')
              }
            } catch {
              // Process may have already exited, ignore
            }
          }, 3000) // 3 second fallback
        }
      }, this.config.timeout)

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        clearTimeout(timeout)
        if (killTimeout) {
          clearTimeout(killTimeout)
        }

        const elapsed = Date.now() - startTime
        if (this.config.debug) {
          console.log(`[agent-browser] completed in ${elapsed}ms (exit: ${code})`)
        }

        if (timedOut) {
          emitReliabilityEvent('driver.agent_browser.command.timeout', 'error', {
            command: args[0] ?? 'unknown',
            timeout_ms: this.config.timeout,
          })
          resolve({
            success: false,
            stdout,
            stderr,
            exitCode: code,
            error: `Command timed out after ${this.config.timeout}ms`,
          })
          return
        }

        if (code !== 0) {
          emitReliabilityEvent('driver.agent_browser.command.failed', 'warn', {
            command: args[0] ?? 'unknown',
            exit_code: code,
            stderr: stderr.trim().slice(0, 500),
          })
        }

        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exitCode: code,
          error: code !== 0 ? stderr.trim() || `Exit code: ${code}` : undefined,
        })
      })

      child.on('error', (err) => {
        clearTimeout(timeout)
        if (killTimeout) {
          clearTimeout(killTimeout)
        }
        emitReliabilityEvent('driver.agent_browser.command.spawn_error', 'error', {
          command: args[0] ?? 'unknown',
          error: err.message,
        })
        resolve({
          success: false,
          stdout,
          stderr,
          exitCode: null,
          error: `Spawn error: ${err.message}`,
        })
      })
    })
  }

  // =========================================================================
  // High-Level Commands
  // =========================================================================

  /**
   * Navigate to a URL.
   */
  async navigate(url: string): Promise<AgentBrowserResult> {
    return this.execute(['open', url])
  }

  /**
   * Take an accessibility snapshot.
   */
  async snapshot(): Promise<AgentBrowserResult> {
    const result = await this.execute(['snapshot'])

    if (result.success) {
      result.snapshot = this.parseSnapshot(result.stdout)
    }

    return result
  }

  /**
   * Click on an element by reference.
   */
  async click(ref: string): Promise<AgentBrowserResult> {
    return this.execute(['click', ref])
  }

  /**
   * Fill a text field.
   */
  async fill(ref: string, value: string): Promise<AgentBrowserResult> {
    return this.execute(['fill', ref, value])
  }

  /**
   * Type text (key by key).
   */
  async type(ref: string, value: string): Promise<AgentBrowserResult> {
    return this.execute(['type', ref, value])
  }

  /**
   * Press a key.
   */
  async pressKey(key: string): Promise<AgentBrowserResult> {
    return this.execute(['press', key])
  }

  /**
   * Select an option in a dropdown.
   */
  async selectOption(ref: string, value: string): Promise<AgentBrowserResult> {
    return this.execute(['select', ref, value])
  }

  /**
   * Hover over an element.
   */
  async hover(ref: string): Promise<AgentBrowserResult> {
    return this.execute(['hover', ref])
  }

  /**
   * Take a screenshot.
   */
  async screenshot(path?: string): Promise<AgentBrowserResult> {
    const args = ['screenshot']
    if (path) {
      args.push(path)
    }
    return this.execute(args)
  }

  /**
   * Get current URL.
   */
  async getCurrentUrl(): Promise<string> {
    const result = await this.execute(['get', 'url'])
    if (!result.success) {
      throw new Error(`Failed to get current URL: ${result.error || result.stderr}`)
    }
    return result.stdout.trim()
  }

  /**
   * Get page title.
   */
  async getTitle(): Promise<string> {
    const result = await this.execute(['get', 'title'])
    if (!result.success) {
      throw new Error(`Failed to get page title: ${result.error || result.stderr}`)
    }
    return result.stdout.trim()
  }

  /**
   * Go back in history.
   */
  async goBack(): Promise<AgentBrowserResult> {
    return this.execute(['back'])
  }

  /**
   * Go forward in history.
   */
  async goForward(): Promise<AgentBrowserResult> {
    return this.execute(['forward'])
  }

  /**
   * Reload the page.
   */
  async reload(): Promise<AgentBrowserResult> {
    return this.execute(['reload'])
  }

  /**
   * Wait for a condition.
   */
  async wait(condition: string, timeout?: number): Promise<AgentBrowserResult> {
    const args = ['wait']
    if (timeout && /^\d+$/.test(condition)) {
      args.push(condition)
      return this.execute(args)
    }
    args.push(condition)
    return this.execute(args)
  }

  /**
   * Evaluate JavaScript in the page.
   */
  async evaluate(script: string): Promise<AgentBrowserResult> {
    return this.execute(['eval', script])
  }

  // =========================================================================
  // Snapshot Parsing
  // =========================================================================

  /**
   * Parse agent-browser snapshot output into structured data.
   *
   * agent-browser snapshots look like:
   * ```
   * - document [ref=@document[0]]
   *   - navigation [ref=@navigation[0]] "Main navigation"
   *     - link [ref=@link[0]] "Home"
   *     - link [ref=@link[1]] "About"
   *   - main [ref=@main[0]]
   *     - heading [ref=@heading[0]] level=1 "Welcome"
   *     - button [ref=@button[0]] "Sign In"
   * ```
   */
  parseSnapshot(output: string): SnapshotData {
    const elements: SnapshotElement[] = []
    const lines = output.split('\n')

    // Pattern to match snapshot lines
    // Examples:
    // - button [ref=@button[0]] "Click me"
    // - textbox [ref=@textbox[0]] value="hello"
    // - heading [ref=@heading[0]] level=1 "Title"
    const linePattern = /^\s*-\s+([\w-]+):?(?:\s+(.*))?$/

    for (const line of lines) {
      const match = line.match(linePattern)
      if (!match) continue

      const [, role, rest = ''] = match

      const refMatch = rest.match(/\[ref=@?([a-zA-Z0-9_-]+)\]/)
      if (!refMatch) continue

      const ref = `@${refMatch[1]}`

      const element: SnapshotElement = {
        ref,
        role,
      }

      // Parse additional properties from the rest of the line
      if (rest) {
        // Extract quoted name
        const nameMatch = rest.match(/"([^"]*)"/)
        if (nameMatch) {
          element.name = nameMatch[1]
        }

        // Extract value="..."
        const valueMatch = rest.match(/value="([^"]*)"/)
        if (valueMatch) {
          element.value = valueMatch[1]
        }

        // Extract level=N
        const levelMatch = rest.match(/(?:level=|\[level=)(\d+)\]?/)
        if (levelMatch) {
          element.properties = {
            ...element.properties,
            level: parseInt(levelMatch[1], 10),
          }
        }

        // Check for disabled
        if (rest.includes('disabled')) {
          element.disabled = true
        }

        // Check for hidden
        if (rest.includes('hidden')) {
          element.hidden = true
        }
      }

      elements.push(element)
    }

    return {
      raw: output,
      elements,
      timestamp: Date.now(),
    }
  }

  /**
   * Find element in snapshot by role and optional name.
   */
  findElement(
    snapshot: SnapshotData,
    role: string,
    options?: { name?: string | RegExp; exact?: boolean }
  ): SnapshotElement | null {
    for (const element of snapshot.elements) {
      // Match role
      if (element.role.toLowerCase() !== role.toLowerCase()) {
        continue
      }

      // Match name if specified
      if (options?.name) {
        if (!element.name) continue

        if (typeof options.name === 'string') {
          if (options.exact) {
            if (element.name !== options.name) continue
          } else {
            if (!element.name.toLowerCase().includes(options.name.toLowerCase())) {
              continue
            }
          }
        } else {
          // RegExp
          if (!options.name.test(element.name)) continue
        }
      }

      return element
    }

    return null
  }

  /**
   * Find all elements matching criteria.
   */
  findElements(
    snapshot: SnapshotData,
    role: string,
    options?: { name?: string | RegExp; exact?: boolean }
  ): SnapshotElement[] {
    const results: SnapshotElement[] = []

    for (const element of snapshot.elements) {
      // Match role
      if (element.role.toLowerCase() !== role.toLowerCase()) {
        continue
      }

      // Match name if specified
      if (options?.name) {
        if (!element.name) continue

        if (typeof options.name === 'string') {
          if (options.exact) {
            if (element.name !== options.name) continue
          } else {
            if (!element.name.toLowerCase().includes(options.name.toLowerCase())) {
              continue
            }
          }
        } else {
          if (!options.name.test(element.name)) continue
        }
      }

      results.push(element)
    }

    return results
  }

  /**
   * Find element by text content.
   */
  findByText(snapshot: SnapshotData, text: string | RegExp): SnapshotElement | null {
    for (const element of snapshot.elements) {
      const content = element.name || element.value || ''

      if (typeof text === 'string') {
        if (content.toLowerCase().includes(text.toLowerCase())) {
          return element
        }
      } else {
        if (text.test(content)) {
          return element
        }
      }
    }

    return null
  }
}
