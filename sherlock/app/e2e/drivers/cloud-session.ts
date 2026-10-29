import { emitReliabilityEvent } from './reliability-events'

export type AgentBrowserMode = 'local' | 'remote-ws'

export interface CloudSessionOptions {
  headless?: boolean
  timeoutMs?: number
  viewport?: {
    width: number
    height: number
  }
}

export interface ManagedCloudSession {
  provider: 'remote-ws'
  wsEndpoint: string
  sessionId?: string
  liveViewUrl?: string
  close: () => Promise<void>
}

export function getAgentBrowserMode(): AgentBrowserMode {
  const envValue = (process.env.E2E_AGENT_BROWSER_MODE ?? 'local').trim()
  if (envValue === 'remote-ws') return 'remote-ws'
  return 'local'
}

export function isStrictCloudMode(mode: AgentBrowserMode): boolean {
  return mode === 'remote-ws'
}

function createRemoteWSSession(endpoint: string): ManagedCloudSession {
  emitReliabilityEvent('cloud.remote_ws.attach', 'info', {
    endpoint_prefix: endpoint.slice(0, 32),
  })

  return {
    provider: 'remote-ws',
    wsEndpoint: endpoint,
    close: async () => {
      // The endpoint is external; we intentionally do not attempt ownership-based cleanup.
    },
  }
}

// Connection options belong to the browser driver; attaching an existing endpoint uses only mode.
export function createManagedCloudSession(
  mode: AgentBrowserMode,
  options: CloudSessionOptions
): Promise<ManagedCloudSession | null>
export async function createManagedCloudSession(
  mode: AgentBrowserMode
): Promise<ManagedCloudSession | null> {
  if (mode === 'local') {
    return null
  }

  if (mode === 'remote-ws') {
    const endpoint = process.env.E2E_AGENT_BROWSER_WS_ENDPOINT?.trim()
    if (!endpoint) {
      throw new Error(
        'E2E_AGENT_BROWSER_WS_ENDPOINT is required for E2E_AGENT_BROWSER_MODE=remote-ws'
      )
    }
    return createRemoteWSSession(endpoint)
  }

  return null
}
