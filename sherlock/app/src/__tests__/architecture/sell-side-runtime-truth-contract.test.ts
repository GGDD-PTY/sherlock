import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import esMessages from '@/messages/es.json'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

describe('active sell-side runtime truth', () => {
  it('enables the temporary intake fixture wherever the journey is invoked', () => {
    const packageJson = JSON.parse(readRepoFile('sherlock/app/package.json')) as {
      scripts: Record<string, string>
    }

    for (const scriptName of ['test:e2e', 'test:e2e:ui', 'test:e2e:headed']) {
      const script = packageJson.scripts[scriptName]
      expect(script, scriptName).toContain('BYPASS_AUTH=true')
      expect(script, scriptName).toContain('NEXT_PUBLIC_BYPASS_AUTH=true')
      expect(script, scriptName).toContain('NEXT_PUBLIC_DEV_AUTH_ENABLED=true')
      expect(script, scriptName).toContain('E2E_INTAKE_FIXTURE=true')
      expect(script, scriptName).toContain('E2E_SERVER_MODE=dev')
      expect(script, scriptName).toContain('e2e/intake-temporary-journey.spec.ts')
    }

    const crossBrowserScript = packageJson.scripts['test:e2e:vdr:cross-browser']
    expect(crossBrowserScript).toContain('E2E_INTAKE_FIXTURE=true')
    expect(crossBrowserScript).toContain('E2E_SERVER_MODE=dev')
    expect(crossBrowserScript).toContain('e2e/intake-temporary-journey.spec.ts')
  })

  // [F] 2026-08-30: copy de cliente sin términos vetados ni features
  // inexistentes. La landing anunciaba Google Drive y MCP «en vista previa»;
  // ninguno de los dos existe, así que el anuncio salió del árbol. Este candado
  // impide que vuelva por cualquiera de sus tres nombres.
  it('never announces a channel the product cannot deliver', () => {
    const landing = readRepoFile('sherlock/app/src/components/mycroft/MycroftLanding.tsx')
    expect(landing).not.toMatch(/mycroft-channel-/)

    const mycroft = esMessages.mycroft as Record<string, unknown>
    expect(Object.keys(mycroft), 'es mycroft namespace').not.toContain('channels')

    // Los conectores que la landing anunciaba sin tenerlos. La palabra
    // «preview» sigue permitida: nombra la prueba privada del producto, no
    // un canal que no existe. MCP ya no está vetado aquí: el canal del agente
    // del cliente existe (`/api/vdr-mcp`, documentado en /ayuda#mcp) y la
    // landing mínima enlaza a esa guía ([F] 2026-09-14).
    expect(JSON.stringify(mycroft), 'es mycroft copy').not.toMatch(/Google Drive|\bERP\b/i)
  })

  it('keeps common and site metadata on the active sell-side positioning', () => {
    expect(esMessages.common.tagline).toBe('Preparación sell-side para América Latina')
    expect(esMessages.site.meta.defaultTitle).toBe('Preparación sell-side para América Latina')

    const activeMetadata = [
      esMessages.common.tagline,
      esMessages.site.meta.defaultTitle,
      esMessages.site.meta.description,
      esMessages.site.meta.imageAlt,
    ].join(' ')

    expect(activeMetadata).toMatch(/sell-side|preparaci[oó]n sell-side/i)
    expect(activeMetadata).not.toMatch(/marketplace|mercado privado de capital/i)
  })
})
