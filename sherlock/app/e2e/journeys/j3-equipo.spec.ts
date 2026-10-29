import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { expect, test } from '@playwright/test'

import { j3PullFloorMessage, j3PullMeetsFloor, parseJourneyKeys } from '../helpers/journey-rules'
import {
  devLogin,
  JOURNEY_ADMIN_EMAIL,
  JOURNEY_COMPANY_NAME,
  JOURNEY_GOAL_MS,
  JOURNEY_OWNER_EMAIL,
  journeyDeliverableName,
  startJourney,
} from '../helpers/journeys'

// J3: el equipo entrega. El admin abre la sala de la empresa, el operador baja
// los documentos con `vdr:pull`, sube un xlsx con `vdr:push --slot MODEL` y el
// cliente ve el entregable en «Preparación». Mycroft no entra: el tiempo del
// motor no es parte de la meta.
const run = promisify(execFile)
const DELIVERABLE_NAME = journeyDeliverableName()

test.describe('J3 el equipo entrega', () => {
  test.setTimeout(JOURNEY_GOAL_MS.J3 * 3)

  test('pull, push de un xlsx v1 y el cliente lo ve', async ({ page }) => {
    const journey = startJourney('J3', page)
    // Los scripts del operador viven en `sherlock/app/scripts/operator`, y
    // Playwright corre con esa carpeta como cwd, igual que `mcp-local.spec.ts`.
    const appDir = process.cwd()
    const operator = (script: string, args: string[]) =>
      run('node', [path.join('scripts', 'operator', script), ...args], { cwd: appDir })

    await journey.step('admin-entra', async () => {
      await devLogin(page, JOURNEY_ADMIN_EMAIL, /\/es\/admin/)
    })

    await journey.step('abre-la-sala', async () => {
      await page.goto('/es/admin/companies', { waitUntil: 'domcontentloaded' })
      const row = page.getByRole('row').filter({ hasText: JOURNEY_COMPANY_NAME })
      await expect(row).toHaveCount(1, { timeout: 60_000 })
      await row.getByRole('button', { name: 'Acciones de empresa' }).click()
      await page.getByRole('menuitem', { name: 'Abrir sala (VDR)' }).click()
      await page.waitForURL(/\/es\/admin\/companies\/.+\/documents/, { timeout: 60_000 })
      await expect(page.getByTestId('vdr-room-shell')).toBeVisible({ timeout: 60_000 })
    })

    await journey.step('vdr-pull', async () => {
      const { stdout } = await operator('vdr-pull.mjs', [
        '--company',
        JOURNEY_COMPANY_NAME,
        '--deployment',
        'local',
      ])
      // Un inbox que ya tiene los archivos cuenta `omitidos`, no `descargados`.
      // Si J1 o J2 corrieron en esta ejecución, acaban de subir archivos y el
      // pull tiene que bajar al menos uno. Solo `--journey j3` acepta omitidos.
      const downloadedMatch = /descargados (\d+)/.exec(stdout)
      const omittedMatch = /omitidos (\d+)/.exec(stdout)
      expect(downloadedMatch, `vdr-pull no reportó descargados: ${stdout.trim()}`).toBeTruthy()
      expect(omittedMatch, `vdr-pull no reportó omitidos: ${stdout.trim()}`).toBeTruthy()
      const downloaded = Number(downloadedMatch![1])
      const omitted = Number(omittedMatch![1])
      const journeys = parseJourneyKeys(process.env.JOURNEYS)
      expect(
        j3PullMeetsFloor(downloaded, omitted, journeys),
        j3PullFloorMessage(journeys, stdout, JOURNEY_COMPANY_NAME)
      ).toBe(true)
    })

    await journey.step('vdr-push', async () => {
      const { stdout } = await operator('vdr-push.mjs', [
        '--company',
        JOURNEY_COMPANY_NAME,
        '--deployment',
        'local',
        '--file',
        path.join('e2e', 'fixtures', 'andina-solar-modelo.xlsx'),
        '--folder',
        'room_financial',
        '--name',
        DELIVERABLE_NAME,
        '--label',
        'v1',
        '--note',
        'Borrador del modelo v1. No es asesoría de inversión.',
        '--slot',
        'MODEL',
      ])
      expect(stdout).toContain('slot MODEL')
    })

    await journey.step('cliente-ve-entregable', async () => {
      await devLogin(page, JOURNEY_OWNER_EMAIL, /\/es\/my-company\/documents/)
      await page.goto('/es/my-company/preparation', { waitUntil: 'domcontentloaded' })
      const stages = page.getByTestId('room-progress-stages')
      await expect(stages).toBeVisible({ timeout: 60_000 })
      await expect(
        stages.getByRole('listitem').filter({ hasText: 'Modelo v1' }).first()
      ).toContainText('Entregado', { timeout: 60_000 })
    })

    journey.end()
  })
})
