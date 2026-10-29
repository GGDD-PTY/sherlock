import { expect, type Page } from '@playwright/test'

export type IntakeFile = { name: string; mimeType: string; buffer: Buffer }

/**
 * `MycroftLanding` es un componente cliente. El SSR ya pintó su input de
 * archivos, pero hasta que React hidrata el árbol nadie escucha su `change`:
 * una selección hecha antes de ese instante se pierde en silencio. Ningún
 * humano cae en la carrera —el botón visible tampoco abre el diálogo del
 * sistema antes de hidratar—, así que la espera es del harness, no del
 * producto. Hasta 2026-09-01 la daba el banner de consentimiento (había que
 * despacharlo antes de seguir); la analítica del sitio es cookieless y
 * `ConsentBanner` ya no renderiza nada, así que aquí se hace explícita.
 */
export async function waitForIntakeHydration(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const input = document.querySelector(
        '[data-testid="mycroft-upload-dossier"] input[type="file"]'
      )
      return (
        input !== null &&
        Object.keys(input).some(
          (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactProps$')
        )
      )
    },
    null,
    { timeout: 30_000 }
  )
}

/** Selecciona documentos en la capa de subida inline y espera a que la lista los refleje. */
export async function selectIntakeFiles(page: Page, files: readonly IntakeFile[]): Promise<void> {
  await waitForIntakeHydration(page)
  await page.getByLabel('Seleccionar documentos').setInputFiles([...files])
  for (const file of files) {
    await expect(page.getByText(file.name, { exact: true })).toBeVisible()
  }
}
