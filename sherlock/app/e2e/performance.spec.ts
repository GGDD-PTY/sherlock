// ============================================================================
// E2E TEST: PERFORMANCE (SLOW 3G)
// ============================================================================
// Tests de performance simulando conexión lenta (Slow 3G)
// Verifica que la app sea usable en condiciones de red limitadas
// ============================================================================

import { test, expect } from '@playwright/test'

// Configuración de Slow 3G según Chrome DevTools
// Nota: Definida para referencia/documentación aunque no se use directamente
// porque Playwright no expone throttling nativo (requiere CDP)
const _SLOW_3G_CONFIG = {
  offline: false,
  downloadThroughput: (500 * 1024) / 8, // 500 Kbps
  uploadThroughput: (500 * 1024) / 8,
  latency: 400, // 400ms RTT
}
void _SLOW_3G_CONFIG // Documentación de la configuración objetivo

test.describe('Performance on Slow 3G', () => {
  test.beforeEach(async ({ page }) => {
    // Usar CDP para throttling de red más preciso (Slow 3G)
    const client = await page.context().newCDPSession(page)
    await client.send('Network.enable')
    await client.send('Network.emulateNetworkConditions', {
      offline: false,
      downloadThroughput: (500 * 1024) / 8, // 500 Kbps → bytes/s
      uploadThroughput: (250 * 1024) / 8, // 250 Kbps → bytes/s
      latency: 400, // 400ms latency (typical Slow 3G)
    })
  })

  test('landing page should load within 25 seconds on slow connection', async ({ page }) => {
    const startTime = Date.now()

    await page.goto('/', {
      waitUntil: 'domcontentloaded',
      timeout: 45000, // Aumentado para dar más tiempo con throttling realista
    })

    const loadTime = Date.now() - startTime

    console.log(`Landing page load time with Slow 3G throttling: ${loadTime}ms`)

    // Con throttling realista de Slow 3G, 25 segundos es un límite razonable
    expect(loadTime).toBeLessThan(25000)

    // Verificar que la página es usable
    await expect(
      page.getByRole('navigation', { name: 'Navegación principal', exact: true })
    ).toBeVisible()
  })

  // La entrada pública a una sala es la del invitado: `/data-room` era una
  // página que solo redirigía y se borró ([F] 2026-09-07 09:00).
  test('guest room entry should load within 30 seconds on slow connection', async ({ page }) => {
    const startTime = Date.now()

    await page.goto('/vdr-guest', {
      waitUntil: 'domcontentloaded',
      timeout: 45000, // Aumentado para throttling realista
    })

    const loadTime = Date.now() - startTime

    console.log(`Guest room entry load time with Slow 3G throttling: ${loadTime}ms`)

    expect(loadTime).toBeLessThan(30000)
  })

  test('core navigation should remain responsive under load', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' })
    // «Empieza tu Data Room» salió del navbar público con la landing mínima
    // ([F] 2026-09-14): el ancla de navegación es el lockup, que vuelve a la
    // home donde vive la capa de subida.
    const homeLink = page
      .getByRole('navigation', { name: 'Navegación principal', exact: true })
      .getByRole('link', { name: 'Inicio de Sherlock', exact: true })
    await expect(homeLink).toBeVisible()

    // Medir tiempo de click a navegación
    const startTime = Date.now()
    await homeLink.click()
    await expect(page).toHaveURL(/\/es\/?$/)
    await expect(page.getByTestId('mycroft-upload-dossier')).toBeVisible()
    const navTime = Date.now() - startTime

    console.log(`Navigation time with Slow 3G throttling: ${navTime}ms`)

    // La navegación debería ser razonablemente rápida incluso en Slow 3G (< 5 segundos)
    expect(navTime).toBeLessThan(5000)
  })
})

test.describe('Core Web Vitals Basics', () => {
  test('should have reasonable First Contentful Paint', async ({ page }) => {
    await page.goto('/')

    // Esperar a que la página esté lista
    await page.waitForLoadState('domcontentloaded')

    // Obtener métricas de performance
    const performanceMetrics = await page.evaluate(() => {
      const entries = performance.getEntriesByType('paint')
      const fcp = entries.find((e) => e.name === 'first-contentful-paint')
      return {
        fcp: fcp ? fcp.startTime : null,
      }
    })

    // ===== VALIDACIÓN DE MÉTRICA FCP =====
    // Si FCP no está disponible, el test debe fallar explícitamente
    // (no silenciosamente pasar con un valor nulo)
    if (performanceMetrics.fcp === null) {
      console.error('First Contentful Paint metric not found - test will fail')
      // Forzamos el fallo del test en lugar de pasar silenciosamente
      expect(performanceMetrics.fcp, 'FCP metric should be available').not.toBeNull()
      return // Early return después del expect fallido (para satisfacer TypeScript)
    }

    console.log(`First Contentful Paint: ${performanceMetrics.fcp}ms`)

    // FCP debería ser < 3 segundos para una buena experiencia de usuario
    // Threshold alineado con Google Core Web Vitals (Good: < 1.8s, Needs Improvement: < 3s)
    expect(performanceMetrics.fcp).toBeLessThan(3000)
  })

  test('should have good Cumulative Layout Shift (CLS)', async ({ page }) => {
    // ===== MEDICIÓN CLS USANDO LAYOUT INSTABILITY API =====
    // Esta es la medición oficial de Core Web Vitals para estabilidad de layout
    // Detecta cualquier cambio de posición de elementos (no solo altura)

    await page.goto('/')
    await page.waitForLoadState('networkidle')

    // Esperar a que la página se estabilice inicialmente
    await page.waitForTimeout(2000)

    // Medir CLS durante 3 segundos de observación
    const cls = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let clsValue = 0

        // Performance Observer para layout shifts
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            // En navegadores modernos, las entradas para `layout-shift` siguen la interfaz `LayoutShift`:
            // https://web.dev/cls/#measure-cls-in-javascript
            // Playwright/TS no siempre la tipa bien, así que definimos el “shape” mínimo sin usar `any`.
            const layoutShift = entry as unknown as { value: number; hadRecentInput: boolean }

            // Solo contar shifts que no fueron causados por input reciente del usuario
            if (!layoutShift.hadRecentInput) {
              clsValue += layoutShift.value
            }
          }
        })

        // Observar layout shifts con buffer para capturar eventos pasados
        observer.observe({ type: 'layout-shift', buffered: true })

        // Observar por 3 segundos para capturar shifts post-carga
        setTimeout(() => {
          observer.disconnect()
          resolve(clsValue)
        }, 3000)
      })
    })

    console.log(`Cumulative Layout Shift (CLS): ${cls}`)

    // ===== THRESHOLDS BASADOS EN CORE WEB VITALS =====
    // Good: < 0.1, Needs Improvement: < 0.25, Poor: >= 0.25
    expect(cls).toBeLessThan(0.1) // Threshold "Good" de Google

    // ===== VALIDACIÓN ADICIONAL =====
    // También verificar que no hay cambios extremos de altura (sanity check)
    const initialHeight = await page.evaluate(() => document.body.scrollHeight)
    await page.waitForTimeout(1000)
    const finalHeight = await page.evaluate(() => document.body.scrollHeight)
    const heightDiff = Math.abs(finalHeight - initialHeight)

    // Si hay cambios grandes de altura, podría indicar problemas de layout
    if (heightDiff > 100) {
      console.warn(
        `⚠️  WARNING: Large height change detected (${heightDiff}px) - investigate layout issues`
      )
    }
  })
})
