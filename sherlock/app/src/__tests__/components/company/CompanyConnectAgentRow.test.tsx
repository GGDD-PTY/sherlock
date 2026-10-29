// ============================================================================
// TESTS: CompanyConnectAgentRow — el comando del MCP al pie de «Equipo»
// ============================================================================
// Tarjeta O4-02: el cliente conecta su agente (Claude Code o Claude Cowork) a
// SU sala con su misma cuenta. Lo que se prueba es lo que el dueño copia: el
// comando exacto, que el botón lo escriba al portapapeles, y el enlace a la
// pregunta de la ayuda.
// ============================================================================

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import esMessages from '@/messages/es.json'
import { CompanyConnectAgentRow } from '@/components/company/CompanyConnectAgentRow'
import { getPublicAppUrl } from '@/lib/site/brand'

const copy = esMessages.roomWorkspace.mcp
const catalogUrl = new URL('/api/vdr-mcp', `${getPublicAppUrl().replace(/\/$/, '')}/`).href
const catalogCommand = `claude mcp add --transport http sherlock ${catalogUrl}`

// El portapapeles se sustituye con un doble propio y no con el global de
// `setup.ts`: así el test habla de su espía y no lee un método del DOM sin
// ligarlo (`typescript/unbound-method`).
const writeText = vi.fn<(text: string) => Promise<void>>()

beforeEach(() => {
  writeText.mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, writable: true })
})

afterEach(() => {
  cleanup()
  writeText.mockReset()
})

describe('CompanyConnectAgentRow', () => {
  it('ships the public MCP command and the help anchor', () => {
    render(<CompanyConnectAgentRow />)

    expect(screen.getByRole('heading', { name: copy.title })).toBeInTheDocument()
    expect(screen.getByText(copy.description)).toBeInTheDocument()
    expect(copy.command).toBe('claude mcp add --transport http sherlock {url}')
    expect(copy.command).not.toContain('https://')
    expect(screen.getByText(catalogCommand)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.howItWorks })).toHaveAttribute(
      'href',
      '/ayuda#mcp'
    )
  })

  it('writes the command to the clipboard and says so', async () => {
    render(<CompanyConnectAgentRow />)

    await userEvent.click(screen.getByRole('button', { name: copy.copy }))

    expect(writeText).toHaveBeenCalledWith(catalogCommand)
    expect(await screen.findByRole('button', { name: copy.copied })).toBeInTheDocument()
  })

  // Sin portapapeles (contexto inseguro o permiso negado) el acceso revienta
  // antes de devolver la promesa: el programa de Effect lo manda al canal de
  // error y la fila le dice al dueño que copie a mano.
  it('tells the owner to copy by hand when the clipboard refuses', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'))
    render(<CompanyConnectAgentRow />)

    await userEvent.click(screen.getByRole('button', { name: copy.copy }))

    expect(await screen.findByText(copy.copyFailed)).toBeInTheDocument()
  })
})
