// El paso 12 de verify:local fijaba el puerto 3015. Un `next start` olvidado en
// ese puerto ponía el gate en rojo sin que nada del repo estuviera mal. El
// selector vive fuera de `verify-local.mjs` para poder probarlo sin arrancar el
// gate (el script corre `main()` al importarse).
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import * as ports from '../../../../../scripts/verify-local-e2e-port.mjs'
const occupied: ReturnType<typeof createServer>[] = []

function occupy(port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const server = createServer()
    server.once('error', rejectListen)
    server.listen(port, '127.0.0.1', () => {
      occupied.push(server)
      resolveListen()
    })
  })
}

afterEach(async () => {
  await Promise.all(
    occupied.splice(0).map((server) => new Promise((done) => server.close(() => done(null))))
  )
})

describe('verify:local E2E port', () => {
  it('takes the first free port from 3015 upward', async () => {
    expect(ports.E2E_PORT_SEARCH_START).toBe(3015)
    await occupy(3015)
    await occupy(3016)

    await expect(ports.pickE2EPort({})).resolves.toBe(3017)
  })

  it('honours VERIFY_LOCAL_E2E_PORT without probing', async () => {
    await expect(ports.pickE2EPort({ VERIFY_LOCAL_E2E_PORT: '4123' })).resolves.toBe(4123)
  })

  it('refuses a VERIFY_LOCAL_E2E_PORT that is not a port number', async () => {
    await expect(ports.pickE2EPort({ VERIFY_LOCAL_E2E_PORT: 'auto' })).rejects.toThrow(
      /VERIFY_LOCAL_E2E_PORT/
    )
  })

  it('derives the redirect URI from the same port', () => {
    expect(ports.e2ePortEnvironment(3017)).toEqual({
      E2E_PORT: '3017',
      NEXT_PUBLIC_WORKOS_REDIRECT_URI: 'http://localhost:3017/callback',
    })
  })

  it('reports a listening port as taken and a free one as free', async () => {
    await occupy(3115)

    await expect(ports.isPortFree(3115)).resolves.toBe(false)
    await expect(ports.isPortFree(3116)).resolves.toBe(true)
  })
})
