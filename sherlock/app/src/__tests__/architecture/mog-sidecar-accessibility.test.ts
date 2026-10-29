import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createMogAccessibilityLifecycle,
  installMogAccessibilityBridge,
  waitForMogPageActive,
} from '../../../mog-sidecar/src/accessibility.js'

const flushMutations = () => new Promise((resolve) => window.setTimeout(resolve, 0))

function knownLiveRegion(role: 'status' | 'alert', text: string) {
  const region = document.createElement('div')
  region.className = 'sr-only'
  region.setAttribute('role', role)
  region.setAttribute('aria-live', role === 'alert' ? 'assertive' : 'polite')
  region.setAttribute('aria-atomic', 'true')
  region.textContent = text
  return region
}

function mountedGrid() {
  const root = document.createElement('div')
  root.id = 'root'
  const grid = document.createElement('div')
  grid.setAttribute('role', 'grid')
  root.append(grid)
  document.body.append(root)
  return { root, grid }
}

function deferred() {
  let resolve: () => void = () => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('Mog sidecar accessibility bridge', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.replaceChildren()
  })

  it('bridges only known Mog live regions and restores their exact attributes on cleanup', async () => {
    const { root, grid } = mountedGrid()
    const status = knownLiveRegion('status', 'Cell A1 selected, empty')
    status.setAttribute('data-sherlock-live-source', 'preexisting-marker')
    const futureCellRegion = document.createElement('div')
    futureCellRegion.setAttribute('role', 'status')
    futureCellRegion.setAttribute('aria-live', 'polite')
    futureCellRegion.setAttribute('aria-atomic', 'true')
    futureCellRegion.textContent = 'Legitimate future cell status'
    grid.append(status, futureCellRegion)

    const cleanup = installMogAccessibilityBridge(root)
    await flushMutations()
    const bridge = document.querySelector<HTMLElement>('[data-sherlock-live-region-bridge]')
    const externalStatus = bridge?.querySelector<HTMLElement>('[data-sherlock-live="status"]')

    expect(bridge?.previousElementSibling).toBe(root)
    expect(grid.contains(status)).toBe(true)
    expect(status).not.toHaveAttribute('role')
    expect(status).toHaveAttribute('aria-hidden', 'true')
    expect(externalStatus).toHaveTextContent('Cell A1 selected, empty')
    expect(futureCellRegion).toHaveAttribute('role', 'status')
    expect(futureCellRegion).not.toHaveAttribute('aria-hidden')
    expect(installMogAccessibilityBridge(root)).toBe(cleanup)
    expect(document.querySelectorAll('[data-sherlock-live-region-bridge]')).toHaveLength(1)

    cleanup()
    expect(bridge).not.toBeInTheDocument()
    expect(status).toHaveAttribute('role', 'status')
    expect(status).toHaveAttribute('aria-live', 'polite')
    expect(status).toHaveAttribute('aria-atomic', 'true')
    expect(status).not.toHaveAttribute('aria-hidden')
    expect(status).toHaveAttribute('data-sherlock-live-source', 'preexisting-marker')
  })

  it('publishes each real change once and rejects an older queued announcement', async () => {
    const queued: Array<() => void> = []
    vi.spyOn(window, 'queueMicrotask').mockImplementation((callback) => queued.push(callback))
    const { root, grid } = mountedGrid()
    const status = knownLiveRegion('status', 'Old selection')
    grid.append(status)

    installMogAccessibilityBridge(root)
    expect(queued).toHaveLength(1)

    status.textContent = 'New selection'
    await flushMutations()
    expect(queued).toHaveLength(2)

    status.textContent = 'New selection'
    await flushMutations()
    expect(queued).toHaveLength(2)

    queued[1]?.()
    queued[0]?.()
    expect(document.querySelector('[data-sherlock-live="status"]')).toHaveTextContent(
      'New selection'
    )
  })

  it('handles a late live role, a late grid role, and a status-to-alert change', async () => {
    const { root, grid } = mountedGrid()
    const lateStatus = document.createElement('div')
    lateStatus.className = 'sr-only'
    lateStatus.setAttribute('aria-live', 'polite')
    lateStatus.setAttribute('aria-atomic', 'true')
    lateStatus.textContent = 'Late status'
    grid.append(lateStatus)

    const lateGrid = document.createElement('div')
    const lateAlert = knownLiveRegion('alert', 'Late grid alert')
    lateGrid.append(lateAlert)
    root.append(lateGrid)
    const cleanup = installMogAccessibilityBridge(root)

    lateStatus.setAttribute('role', 'status')
    lateGrid.setAttribute('role', 'grid')
    await flushMutations()
    expect(lateStatus).not.toHaveAttribute('role')
    expect(lateAlert).not.toHaveAttribute('role')

    lateStatus.setAttribute('role', 'alert')
    lateStatus.setAttribute('aria-live', 'assertive')
    lateStatus.textContent = 'Changed to alert'
    await flushMutations()
    expect(lateStatus).toHaveAttribute('data-sherlock-live-source', 'alert')
    expect(document.querySelector('[data-sherlock-live="status"]')).toHaveTextContent('')
    expect(document.querySelector('[data-sherlock-live="alert"]')).toHaveTextContent(
      'Changed to alert'
    )

    cleanup()
    expect(lateStatus).toHaveAttribute('role', 'alert')
    expect(lateStatus).toHaveAttribute('aria-live', 'assertive')
  })

  it('releases removed sources and treats a remount as a fresh source', async () => {
    const { root, grid } = mountedGrid()
    const status = knownLiveRegion('status', 'Detach me')
    grid.append(status)
    const cleanup = installMogAccessibilityBridge(root)
    await flushMutations()

    status.remove()
    await flushMutations()
    expect(status).toHaveAttribute('role', 'status')
    expect(status).not.toHaveAttribute('aria-hidden')
    expect(status).not.toHaveAttribute('data-sherlock-live-source')

    grid.append(status)
    await flushMutations()
    expect(status).not.toHaveAttribute('role')
    expect(status).toHaveAttribute('aria-hidden', 'true')

    cleanup()
    expect(status).toHaveAttribute('role', 'status')
  })

  it('cleans up on pagehide and reinstalls after a persisted pageshow', async () => {
    const { root, grid } = mountedGrid()
    const status = knownLiveRegion('status', 'BFCache status')
    grid.append(status)
    const lifecycle = createMogAccessibilityLifecycle(root, window)
    await flushMutations()
    expect(document.querySelectorAll('[data-sherlock-live-region-bridge]')).toHaveLength(1)

    window.dispatchEvent(new Event('pagehide'))
    expect(document.querySelectorAll('[data-sherlock-live-region-bridge]')).toHaveLength(0)
    expect(status).toHaveAttribute('role', 'status')
    expect(lifecycle.ensure()).toBe(false)
    expect(lifecycle.whenActive()).toBe(lifecycle.whenActive())

    const pageshow = new Event('pageshow')
    Object.defineProperty(pageshow, 'persisted', { value: true })
    window.dispatchEvent(pageshow)
    await flushMutations()
    expect(document.querySelectorAll('[data-sherlock-live-region-bridge]')).toHaveLength(1)
    expect(status).not.toHaveAttribute('role')

    lifecycle.dispose()
    expect(document.querySelectorAll('[data-sherlock-live-region-bridge]')).toHaveLength(0)
    expect(status).toHaveAttribute('role', 'status')
  })

  it('waits for pageshow before one mount when pagehide lands during workbook readiness', async () => {
    const { root, grid } = mountedGrid()
    grid.append(knownLiveRegion('status', 'Async workbook'))
    const lifecycle = createMogAccessibilityLifecycle(root, window)
    const workbookReady = deferred()
    let mounts = 0
    let opened = 0

    const opening = (async () => {
      await workbookReady.promise
      if (!(await waitForMogPageActive(lifecycle))) return
      mounts++
      opened++
    })()

    window.dispatchEvent(new Event('pagehide'))
    workbookReady.resolve()
    await flushMutations()
    expect(mounts).toBe(0)
    expect(opened).toBe(0)

    const pageshow = new Event('pageshow')
    Object.defineProperty(pageshow, 'persisted', { value: true })
    window.dispatchEvent(pageshow)
    await opening
    expect(mounts).toBe(1)
    expect(opened).toBe(1)

    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(pageshow)
    window.dispatchEvent(new Event('pagehide'))
    window.dispatchEvent(pageshow)
    await flushMutations()
    expect(mounts).toBe(1)
    expect(opened).toBe(1)

    lifecycle.dispose()
    window.dispatchEvent(pageshow)
    expect(document.querySelectorAll('[data-sherlock-live-region-bridge]')).toHaveLength(0)
  })
})
