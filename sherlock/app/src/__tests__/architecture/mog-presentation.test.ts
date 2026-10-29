import { afterEach, describe, expect, it } from 'vitest'
import { installMogPresentation } from '../../../mog-sidecar/src/presentation.js'

afterEach(() => document.body.replaceChildren())

describe('Mog reader presentation', () => {
  it('localizes controls without rewriting cell values or sheet names', () => {
    const root = document.createElement('div')
    root.innerHTML =
      '<button aria-label="Zoom out"></button><span>Ready</span><div role="grid"><span>Ready</span></div><div role="tablist"><span>Count</span></div><button data-testid="debug-record-button">Record</button>'
    document.body.append(root)
    const cleanup = installMogPresentation(root)
    expect(root.querySelector('button')).toHaveAttribute('aria-label', 'Reducir zoom')
    expect(root.children[1]).toHaveTextContent('Listo')
    expect(root.querySelector('[role="grid"]')).toHaveTextContent('Ready')
    expect(root.querySelector('[role="tablist"]')).toHaveTextContent('Count')
    expect(root.querySelector('[data-testid="debug-record-button"]')).not.toBeVisible()
    expect(root.querySelector('[data-testid="debug-record-button"]')).toBeDisabled()
    cleanup()
  })
})
