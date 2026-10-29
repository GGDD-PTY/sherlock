import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Schema } from 'effect'

import { expect, it } from 'vitest'

it('warms authenticated routes and drains each response before requesting the next', async () => {
  const requests: {
    path: string | undefined
    method: string | undefined
    cookie: string | undefined
  }[] = []
  let pending = 0
  let maxPending = 0
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      cookie: request.headers.cookie,
    })
    pending += 1
    maxPending = Math.max(maxPending, pending)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.flushHeaders()
    setTimeout(() => {
      pending -= 1
      response.end('compiled')
    }, 10)
  })
  await new Promise<void>((ready) => {
    server.listen(0, '127.0.0.1', ready)
  })

  try {
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }))(
      server.address()
    )
    await promisify(execFile)(process.execPath, [
      '--input-type=module',
      '-e',
      'const { warm } = await import(process.argv[1]); await warm(process.argv[2])',
      pathToFileURL(resolve('../../scripts/journeys-local.mjs')).href,
      `http://127.0.0.1:${address.port}`,
    ])
    expect(requests).toContainEqual({
      path: '/api/analytics/journey',
      method: 'POST',
      cookie: 'sherlock_dev_user=dev_company_001; sherlock_dev_role=COMPANY',
    })
    expect(requests.some((request) => request.path === '/es/onboarding')).toBe(true)
    expect(maxPending).toBe(1)
    expect(pending).toBe(0)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((closed) => {
      server.close(() => {
        closed()
      })
    })
  }
})
