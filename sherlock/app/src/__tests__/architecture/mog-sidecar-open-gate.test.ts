import { afterEach, describe, expect, it } from 'vitest'

import {
  createMogAccessibilityLifecycle,
  waitForMogPageActive,
} from '../../../mog-sidecar/src/accessibility.js'
import { createMogOpenController } from '../../../mog-sidecar/src/open-gate.js'

const flush = () => new Promise((resolve) => window.setTimeout(resolve, 0))

type OpenPayload = { id: string }
type OpenAttempt = {
  isCurrent: () => boolean
  markOpened: () => boolean
  fail: () => boolean
  handleFailure: () => 'report' | 'ignore'
}

function reportAttemptFailure(
  attempt: OpenAttempt,
  error: unknown,
  onFailure: (error: unknown) => void
) {
  if (attempt.handleFailure() === 'report') onFailure(error)
}

function mountedRoot() {
  const root = document.createElement('div')
  root.id = 'root'
  document.body.append(root)
  return root
}

function persistedPageShow() {
  const event = new Event('pageshow')
  Object.defineProperty(event, 'persisted', { value: true })
  return event
}

describe('Mog sidecar sealed open gate', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('accepts the first hidden open and mounts/posts opened exactly once after pageshow', async () => {
    const lifecycle = createMogAccessibilityLifecycle(mountedRoot(), window)
    window.dispatchEvent(new Event('pagehide'))
    const counts = { runtime: 0, workbook: 0, mount: 0, opened: 0 }
    const ready: Array<() => void> = []
    let openedPayload = ''

    const controller = createMogOpenController({
      open: async (payload: OpenPayload, attempt: OpenAttempt) => {
        counts.runtime++
        counts.workbook++
        if (!(await waitForMogPageActive(lifecycle)) || !attempt.isCurrent()) return
        counts.mount++
        ready.push(() => {
          if (!attempt.markOpened()) return
          counts.opened++
          openedPayload = payload.id
        })
      },
      onFailure: () => undefined,
    })

    expect(controller.accept({ id: 'first' })).toBe(true)
    expect(controller.accept({ id: 'duplicate-hidden' })).toBe(false)
    await flush()
    expect(counts).toEqual({ runtime: 1, workbook: 1, mount: 0, opened: 0 })

    window.dispatchEvent(persistedPageShow())
    await flush()
    expect(counts.mount).toBe(1)
    ready[0]?.()
    expect(counts.opened).toBe(1)
    expect(openedPayload).toBe('first')
    expect(controller.accept({ id: 'duplicate-opened' })).toBe(false)
    expect(counts).toEqual({ runtime: 1, workbook: 1, mount: 1, opened: 1 })

    lifecycle.dispose()
  })

  it('returns to idle after a pre-open failure so one explicit retry can succeed', async () => {
    let opens = 0
    let failures = 0
    let mounts = 0
    let opened = 0
    const controller = createMogOpenController({
      open: async (_payload: OpenPayload, attempt: OpenAttempt) => {
        opens++
        if (opens === 1) throw new Error('runtime failed')
        mounts++
        if (attempt.markOpened()) opened++
      },
      onFailure: () => failures++,
    })

    expect(controller.accept({ id: 'fails' })).toBe(true)
    await flush()
    expect({ opens, failures, mounts, opened }).toEqual({
      opens: 1,
      failures: 1,
      mounts: 0,
      opened: 0,
    })

    expect(controller.accept({ id: 'retry' })).toBe(true)
    await flush()
    expect({ opens, failures, mounts, opened }).toEqual({
      opens: 2,
      failures: 1,
      mounts: 1,
      opened: 1,
    })
    expect(controller.accept({ id: 'after-opened' })).toBe(false)
  })

  it('prevents a failed generation from posting opened after its retry starts', async () => {
    const attempts: Array<{
      fail: () => boolean
      markOpened: () => boolean
    }> = []
    const controller = createMogOpenController({
      open: async (_payload: OpenPayload, attempt: OpenAttempt) => {
        attempts.push(attempt)
      },
      onFailure: () => undefined,
    })

    expect(controller.accept({ id: 'first' })).toBe(true)
    await flush()
    expect(attempts[0]?.fail()).toBe(true)
    expect(controller.accept({ id: 'retry' })).toBe(true)
    await flush()

    expect(attempts[0]?.markOpened()).toBe(false)
    expect(attempts[1]?.markOpened()).toBe(true)
    expect(controller.accept({ id: 'duplicate' })).toBe(false)
  })

  it('reports one opening error, returns to idle, and ignores its duplicate after retry starts', async () => {
    const attempts: OpenAttempt[] = []
    const reported: unknown[] = []
    const controller = createMogOpenController({
      open: async (_payload: OpenPayload, attempt: OpenAttempt) => {
        attempts.push(attempt)
      },
      onFailure: (error: unknown) => reported.push(error),
    })

    expect(controller.accept({ id: 'first' })).toBe(true)
    await flush()

    const firstError = new Error('first failed')
    reportAttemptFailure(attempts[0]!, firstError, (error) => reported.push(error))
    expect(reported).toEqual([firstError])
    expect(controller.accept({ id: 'retry' })).toBe(true)
    await flush()

    reportAttemptFailure(attempts[0]!, new Error('late duplicate'), (error) => reported.push(error))
    expect(reported).toEqual([firstError])
    expect(attempts[1]?.markOpened()).toBe(true)
  })

  it('shares one failure decision between onError and the rejected open promise', async () => {
    const reported: unknown[] = []
    const callbackError = new Error('callback and promise failed')
    const controller = createMogOpenController({
      open: async (_payload: OpenPayload, attempt: OpenAttempt) => {
        reportAttemptFailure(attempt, callbackError, (error) => reported.push(error))
        throw callbackError
      },
      onFailure: (error: unknown) => reported.push(error),
    })

    expect(controller.accept({ id: 'fails-twice' })).toBe(true)
    await flush()

    expect(reported).toEqual([callbackError])
    expect(controller.accept({ id: 'retry' })).toBe(true)
  })

  it('reports one current post-open error without reopening the sealed gate', async () => {
    let attempt: OpenAttempt | undefined
    const reported: unknown[] = []
    const controller = createMogOpenController({
      open: async (_payload: OpenPayload, currentAttempt: OpenAttempt) => {
        attempt = currentAttempt
        currentAttempt.markOpened()
      },
      onFailure: (error: unknown) => reported.push(error),
    })

    expect(controller.accept({ id: 'opened' })).toBe(true)
    await flush()

    const openedError = new Error('opened runtime failed')
    reportAttemptFailure(attempt!, openedError, (error) => reported.push(error))
    reportAttemptFailure(attempt!, new Error('duplicate opened error'), (error) =>
      reported.push(error)
    )

    expect(reported).toEqual([openedError])
    expect(controller.accept({ id: 'must-stay-sealed' })).toBe(false)
  })
})
