import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(process.cwd(), 'scripts/convex-local.mjs')

function run(args: string[]) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: resolve(process.cwd()),
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr ?? '', stdout: result.stdout ?? '' }
}

async function load() {
  return (await import(pathToFileURL(SCRIPT).href)) as {
    parseMcpTokenArgs: (argv: string[]) => {
      email: string
      minutes: number
      scope: string
      role: string | null
    }
    workosSubjectForDevEmail: (email: string) => string
  }
}

describe('convex-local.mjs mcp-token — parseo', () => {
  it('exige --email y defaulta 60 minutos', async () => {
    const { parseMcpTokenArgs } = await load()
    expect(parseMcpTokenArgs(['--email', 'company@dev.local'])).toEqual({
      email: 'company@dev.local',
      minutes: 60,
      scope: 'openid',
      role: null,
    })
  })

  it('honra --minutos', async () => {
    const { parseMcpTokenArgs } = await load()
    expect(parseMcpTokenArgs(['--email', 'ops@dev.local', '--minutos', '15'])).toEqual({
      email: 'ops@dev.local',
      minutes: 15,
      scope: 'openid',
      role: null,
    })
  })

  it('honra --scope openid vdr:write', async () => {
    const { parseMcpTokenArgs } = await load()
    expect(
      parseMcpTokenArgs(['--email', 'company@dev.local', '--scope', 'openid vdr:write'])
    ).toEqual({
      email: 'company@dev.local',
      minutes: 60,
      scope: 'openid vdr:write',
      role: null,
    })
  })

  it('honra --role', async () => {
    const { parseMcpTokenArgs } = await load()
    expect(parseMcpTokenArgs(['--email', 'company@dev.local', '--role', 'company_owner'])).toEqual({
      email: 'company@dev.local',
      minutes: 60,
      scope: 'openid',
      role: 'company_owner',
    })
  })

  it('usa el workosUserId fijo de company@dev.local', async () => {
    const { workosSubjectForDevEmail } = await load()
    expect(workosSubjectForDevEmail('company@dev.local')).toBe('dev_company_001_workos')
  })

  it('deriva el subject de un dueño sembrado por slug', async () => {
    const { workosSubjectForDevEmail } = await load()
    expect(workosSubjectForDevEmail('samplefoods-foods@dev.local')).toBe('dev_samplefoods-foods-dev-local_workos')
  })
})

describe('convex-local.mjs mcp-token — rechazos', () => {
  it('exige --email', () => {
    const result = run(['mcp-token'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--email es obligatorio/)
  })

  it('rechaza un correo que no es @dev.local', () => {
    const result = run(['mcp-token', '--email', 'fer@example.com'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/@dev\.local/)
  })

  it('rechaza un --minutos que no es un entero', () => {
    const result = run(['mcp-token', '--email', 'company@dev.local', '--minutos', '1.5'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--minutos/)
  })

  it('rechaza un --scope sin openid', () => {
    const result = run(['mcp-token', '--email', 'company@dev.local', '--scope', 'vdr:write'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/openid/)
  })

  it('rechaza un --role que no es un slug', () => {
    const result = run(['mcp-token', '--email', 'company@dev.local', '--role', 'Company Owner'])
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/--role/)
  })
})

describe('convex-local.mjs mcp-token — JWT', () => {
  it('imprime un JWT RS256 con el subject sembrado y el comando de Claude Code', () => {
    const result = run(['mcp-token', '--email', 'company@dev.local'])
    expect(result.status).toBe(0)
    const [token = '', command = ''] = result.stdout.trim().split('\n')
    const parts = token.split('.')
    expect(parts).toHaveLength(3)
    const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
      sub?: string
      iss?: string
      aud?: string
      organization_id?: string
      client_id?: string
      scope?: string
    }
    expect(payload.sub).toBe('dev_company_001_workos')
    expect(payload.iss).toMatch(/^http:\/\/localhost:\d+\/api\/dev$/)
    expect(payload.aud).toMatch(/^http:\/\/localhost:\d+\/api\/vdr-mcp$/)
    expect(payload.organization_id).toBe('dev-local')
    expect(payload.client_id).toBe('claude-code-local')
    expect(payload.scope).toBe('openid')
    expect(command).toContain('claude mcp add --transport http sherlock-local')
    expect(command).toContain(`Authorization: Bearer ${token}`)
  })

  it('pone el claim sherlock_role cuando se pide --role', () => {
    const result = run(['mcp-token', '--email', 'company@dev.local', '--role', 'company_owner'])
    expect(result.status).toBe(0)
    const token = result.stdout.trim().split('\n')[0]
    const payloadSegment = token.split('.')[1]
    expect(payloadSegment).toEqual(expect.any(String))
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope?: string
      sherlock_role?: string
    }
    expect(payload.scope).toBe('openid')
    expect(payload.sherlock_role).toBe('company_owner')
  })

  it('no pone el claim sherlock_role sin --role', () => {
    const result = run(['mcp-token', '--email', 'company@dev.local'])
    expect(result.status).toBe(0)
    const token = result.stdout.trim().split('\n')[0]
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    ) as Record<string, unknown>
    expect(payload).not.toHaveProperty('sherlock_role')
  })

  it('firma openid vdr:write cuando se pide --scope', () => {
    const result = run(['mcp-token', '--email', 'company@dev.local', '--scope', 'openid vdr:write'])
    expect(result.status).toBe(0)
    const token = result.stdout.trim().split('\n')[0]
    const payloadSegment = token.split('.')[1]
    expect(payloadSegment).toEqual(expect.any(String))
    const payload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as {
      scope?: string
    }
    expect(payload.scope).toBe('openid vdr:write')
  })
})

describe('convex-local.mjs env — MCP local', () => {
  it('exporta VDR_MCP_ENABLED y las URLs loopback del banco', () => {
    const result = run(['env'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/^VDR_MCP_ENABLED=true$/m)
    expect(result.stdout).toMatch(/^MCP_OAUTH_ISSUER=http:\/\/localhost:\d+\/api\/dev$/m)
    expect(result.stdout).toMatch(/^MCP_OAUTH_JWKS_URL=http:\/\/localhost:\d+\/api\/dev\/jwks$/m)
    expect(result.stdout).toMatch(/^VDR_MCP_OAUTH_AUDIENCE=http:\/\/localhost:\d+\/api\/vdr-mcp$/m)
    expect(result.stdout).toMatch(/^VDR_MCP_OAUTH_SCOPE_BASE=openid$/m)
  })
})
