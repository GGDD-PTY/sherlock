import { expect, test, type Response } from '@playwright/test'

function localHostname(baseURL: string | undefined): string {
  if (!baseURL) throw new Error('Expected a local base URL')
  return new URL(baseURL).hostname
}

function warnLargeJs(size: number): void {
  if (size > 5 * 1024 * 1024) {
    console.warn('JS bundle size exceeds the 5 MB advisory threshold.')
  }
}

function createResourceCollector() {
  const resources: { kind: 'js' | 'css'; size: number }[] = []
  const failedReads: string[] = []
  const pendingReads: Promise<void>[] = []
  const readResource = async (response: Response): Promise<void> => {
    const pathname = new URL(response.url()).pathname
    if (!pathname.startsWith('/_next/')) return
    const kind = pathname.endsWith('.js') ? 'js' : pathname.endsWith('.css') ? 'css' : null
    if (!kind) return
    try {
      const buffer = await response.body()
      if (!response.ok()) failedReads.push(pathname)
      resources.push({ kind, size: buffer.length })
    } catch {
      failedReads.push(pathname)
    }
  }
  const collectResource = (response: Response): void => {
    pendingReads.push(readResource(response))
  }
  return { resources, failedReads, pendingReads, collectResource }
}

test.describe('Bundle Size Checks', () => {
  test('should not load excessively large bundles', async ({ page, baseURL }) => {
    expect(process.env.E2E_SERVER_MODE).toBe('start')
    expect(process.env.PLAYWRIGHT_REUSE_SERVER).not.toBe('true')
    expect(baseURL).toBeTruthy()
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(localHostname(baseURL))

    const { resources, failedReads, pendingReads, collectResource } = createResourceCollector()
    page.on('response', collectResource)

    await page.goto('/')
    await page.waitForLoadState('networkidle')
    page.off('response', collectResource)
    await Promise.all(pendingReads)
    expect(failedReads).toEqual([])

    const jsResources = resources.filter((resource) => resource.kind === 'js')
    const cssResources = resources.filter((resource) => resource.kind === 'css')
    expect(jsResources.length).toBeGreaterThan(0)
    const totalJsSize = jsResources.reduce((total, resource) => total + resource.size, 0)
    const inlineCss = await page.locator('style').allTextContents()
    const inlineCssSize = inlineCss.reduce(
      (total, css) => total + Buffer.byteLength(css, 'utf8'),
      0
    )
    const externalCssSize = cssResources.reduce((total, resource) => total + resource.size, 0)
    const totalCssSize = inlineCssSize + externalCssSize
    expect(totalJsSize).toBeGreaterThan(0)
    expect(totalCssSize).toBeGreaterThan(0)

    console.log(`Total JS size: ${(totalJsSize / 1024).toFixed(2)} KB`)
    console.log(`Total CSS size: ${(totalCssSize / 1024).toFixed(2)} KB`)
    warnLargeJs(totalJsSize)
    expect(totalJsSize).toBeLessThan(8 * 1024 * 1024)
    expect(totalCssSize).toBeLessThan(500 * 1024)
  })
})
