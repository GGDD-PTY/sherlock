// Puerto de los pasos E2E de `verify:local`. Vive aparte del gate porque
// `verify-local.mjs` corre `main()` al importarse y no se puede probar; aquí el
// selector queda cubierto por `src/__tests__/scripts/verify-local-e2e-port.test.ts`.
//
// `VERIFY_LOCAL_E2E_PORT` fuerza un puerto; sin ella se toma el primer libre
// desde 3015, para que un `next start` olvidado no ponga el gate en rojo.

import { createServer } from 'node:net'

export const E2E_PORT_SEARCH_START = 3015
const E2E_PORT_SEARCH_SPAN = 100

/** @returns {Promise<boolean>} */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

/** @param {Record<string, string | undefined>} [environment] */
export async function pickE2EPort(environment = process.env) {
  const requested = environment.VERIFY_LOCAL_E2E_PORT
  if (requested !== undefined && requested !== '') {
    const port = Number(requested)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`VERIFY_LOCAL_E2E_PORT is not a port number: ${requested}`)
    }
    return port
  }

  const last = E2E_PORT_SEARCH_START + E2E_PORT_SEARCH_SPAN
  for (let port = E2E_PORT_SEARCH_START; port <= last; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(
    `No free port between ${E2E_PORT_SEARCH_START} and ${last} for the E2E steps. ` +
      'Free one or set VERIFY_LOCAL_E2E_PORT.'
  )
}

export function e2ePortEnvironment(port) {
  return {
    E2E_PORT: String(port),
    NEXT_PUBLIC_WORKOS_REDIRECT_URI: `http://localhost:${port}/callback`,
  }
}
