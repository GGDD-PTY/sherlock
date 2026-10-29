import { Effect } from 'effect'

import { runServerEffect } from '@/lib/effect/runtime'
import {
  isVdrMcpEnabled,
  vdrMcpHiddenVerbHandlers,
  vdrMcpUnavailableResponse,
} from '@/lib/vdr-mcp/config'
import { createVdrMcpPostHandler, vdrMcpErrorResponse } from '@/lib/vdr-mcp/http'
import { createVdrMcpHandler } from '@/lib/vdr-mcp/mcp'
import { vdrMcpOAuthConfigFromEnv } from '@/lib/vdr-mcp/oauth'
import { createConvexVdrReadStore } from '@/lib/vdr-mcp/store'

// XLSX and PDF reading run native/WASM code and Node streams: this route can
// never run on the edge runtime.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const { GET, PUT, PATCH, DELETE, OPTIONS } = vdrMcpHiddenVerbHandlers('POST')

const postVdrMcp = Effect.fn('VdrMcpRoute.POST')(function* (request: Request) {
  if (!isVdrMcpEnabled()) return vdrMcpUnavailableResponse()

  const store = yield* Effect.sync(() => createConvexVdrReadStore())
  const oauthConfig = yield* Effect.sync(() => vdrMcpOAuthConfigFromEnv())
  const handler = createVdrMcpPostHandler({
    oauthConfig,
    mcpHandler: createVdrMcpHandler({
      store,
      audit: (principal) => (entry) =>
        runServerEffect(
          Effect.promise(() =>
            store.recordAudit({
              principalId: principal.principalId,
              clientId: principal.clientId,
              ...entry,
            })
          ).pipe(Effect.catchCause(() => Effect.sync(() => {})))
        ),
    }),
  })

  return yield* Effect.promise(() => handler(request))
})

export function POST(request: Request): Promise<Response> {
  return runServerEffect(
    postVdrMcp(request).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed(
          vdrMcpErrorResponse(
            process.env.VDR_MCP_OAUTH_AUDIENCE ?? '',
            cause.reasons[0]?._tag === 'Fail' ? cause.reasons[0].error : cause
          )
        )
      )
    )
  )
}
