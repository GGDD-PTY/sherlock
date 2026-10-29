import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(APP_ROOT, relativePath))
}

describe('company preparation workspace composition', () => {
  const workspace = read('src/components/company/MyCompanyDocumentsClient.tsx')

  // [F] 2026-08-30 03:44: data room del cliente = 3 bloques. La sala, el modelo
  // financiero con Mycroft y el hilo con el equipo. Los cuatro bloques de
  // preparación («Estado de preparación», «Ruta de preparación», «Inventario de
  // información», «Tu paquete de preparación») salieron del cliente y no se
  // mudaron a admin: enterraban lo que el cliente vino a pedir.
  // [F] 2026-09-11 17:15 (docs/design-system-vdr.md): los tres bloques son
  // tres pantallas. El shell vive solo en la de documentos; la preparación y
  // el hilo tienen su ruta bajo /my-company.
  it('keeps the company room as screens and removes deal-era orchestration', () => {
    expect(workspace).toContain('<RoomShell')
    expect(read('src/components/company/CompanyPreparationScreen.tsx')).toContain(
      '<RoomProgressPanel'
    )
    expect(read('src/app/[locale]/(app)/my-company/preparation/page.tsx')).toContain(
      '<CompanyPreparationScreen'
    )
    expect(read('src/app/[locale]/(app)/my-company/team/page.tsx')).toContain('<SupportThread')

    // La tarjeta de «MCP» era un placeholder de roadmap con una sigla interna:
    // el mensaje vive ahora como una línea dentro del panel de Mycroft.
    expect(workspace).not.toContain('McpConnectorPreview')

    for (const retired of [
      'PreparationProcessingStatus',
      'ReadinessLadder',
      'IntakeInventory',
      'DeliverablesWorkspace',
      'VdrDocumentBrowser',
      'VdrRoomRail',
      'VdrDashboardStudio',
      'VdrWorkflowStudioPanel',
      'DueDiligenceChecklist',
      'DocumentRequests',
      'VdrQuestionsPanel',
      'VdrEngagementPanel',
      'VdrGuestAccessPanel',
      'VdrAccessControlCard',
    ]) {
      expect(workspace, retired).not.toContain(retired)
    }
  })

  // Los cuatro bloques salieron del árbol, no de la composición: dejarlos como
  // archivos sin caller los volvía a invitar a la pantalla.
  it('keeps the retired preparation blocks out of the tree', () => {
    for (const retired of [
      'src/components/company/PreparationProcessingStatus.tsx',
      'src/components/company/ReadinessLadder.tsx',
      'src/components/company/IntakeInventory.tsx',
      'src/components/company/DeliverablesWorkspace.tsx',
      'src/components/company/TeamDeliveryPanel.tsx',
    ]) {
      expect(exists(retired), retired).toBe(false)
    }
  })

  // El selector de salas por transacción volvió como prop resuelta en el
  // servidor (`companies.getMyVdrWorkspace`, con su RBAC): recibir `rooms` ya
  // no es la señal de la era marketplace. Lo que sigue vetado es que la
  // pantalla se traiga deals por su cuenta.
  it('does not fetch deal rooms from the primary company workspace', () => {
    expect(workspace).not.toContain('getDemoCreatedDeals')
    expect(workspace).not.toContain('api.deals')
    expect(read('src/app/[locale]/(app)/my-company/documents/page.tsx')).not.toContain(
      'getDemoCreatedDeals'
    )
  })

  it('keeps the retired browser and command bar absent without changing the active composition', () => {
    expect(exists('src/components/company/vdr/VdrDocumentBrowser.tsx')).toBe(false)
    expect(exists('src/components/company/vdr/VdrCommandBar.tsx')).toBe(false)
    expect(workspace).toContain('<RoomShell')
  })
})
