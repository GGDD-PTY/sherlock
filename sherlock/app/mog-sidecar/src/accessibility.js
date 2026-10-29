// Mog 0.10.5 monta dos live regions dentro de `role=grid`. Eso conserva los
// anuncios, pero viola la anatomia ARIA del grid. Esta capa Sherlock-owned no
// mueve nodos que pertenecen a React: replica los anuncios fuera de `#root` y
// neutraliza solo las copias internas mientras el sidecar esta montado.

const installations = new WeakMap()
const SOURCE_MARKER = 'data-sherlock-live-source'
const CANDIDATE_SELECTOR =
  '.sr-only[role="status"][aria-live][aria-atomic="true"], .sr-only[role="alert"][aria-live][aria-atomic="true"], .sr-only[data-sherlock-live-source]'
const SNAPSHOT_ATTRIBUTES = ['role', 'aria-live', 'aria-atomic', 'aria-hidden', SOURCE_MARKER]
const OBSERVED_ATTRIBUTES = [...SNAPSHOT_ATTRIBUTES, 'class']
const LIVE_KINDS = ['status', 'alert']

function snapshotAttributes(element) {
  return Object.fromEntries(
    SNAPSHOT_ATTRIBUTES.map((attribute) => [attribute, element.getAttribute(attribute)])
  )
}

function restoreAttributes(element, snapshot) {
  for (const attribute of SNAPSHOT_ATTRIBUTES) {
    const value = snapshot[attribute]
    if (value === null) element.removeAttribute(attribute)
    else element.setAttribute(attribute, value)
  }
}

function createExternalLiveRegion(document, role) {
  const region = document.createElement('div')
  region.setAttribute('data-sherlock-live', role)
  region.setAttribute('role', role)
  region.setAttribute('aria-live', role === 'alert' ? 'assertive' : 'polite')
  region.setAttribute('aria-atomic', 'true')
  return region
}

/**
 * Bridges invalid live regions out of Mog's React-owned grid without moving
 * them. The returned cleanup is idempotent and restores every source node.
 *
 * @param {HTMLElement} root Mog's React mount root.
 * @returns {() => void}
 */
export function installMogAccessibilityBridge(root) {
  const existing = installations.get(root)
  if (existing) return existing

  const document = root.ownerDocument
  const parent = root.parentNode
  if (!parent) throw new Error('Mog accessibility bridge requires a mounted root')

  const bridge = document.createElement('div')
  bridge.setAttribute('data-sherlock-live-region-bridge', '')
  const external = {
    status: createExternalLiveRegion(document, 'status'),
    alert: createExternalLiveRegion(document, 'alert'),
  }
  bridge.append(external.status, external.alert)
  parent.insertBefore(bridge, root.nextSibling)

  /** @type {WeakMap<HTMLElement, { kind: 'status' | 'alert', snapshot: Record<string, string | null> }>} */
  const sourceStates = new WeakMap()
  /** @type {Set<HTMLElement>} */
  const trackedSources = new Set()
  const sourcesByKind = { status: new Set(), alert: new Set() }
  const desiredText = { status: null, alert: null }
  const revisions = { status: 0, alert: 0 }
  let active = true
  let observer = null
  let observing = false

  const observe = () => {
    if (!active || observing || !observer) return
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: OBSERVED_ATTRIBUTES,
    })
    observing = true
  }

  // Las mutaciones propias no deben volver por el observer. Desconectar aqui
  // no pierde cambios externos: JS es single-threaded y todos los records que
  // existian ya forman parte del batch que se esta procesando.
  const mutateSource = (mutation) => {
    const resume = observing
    if (resume) {
      observer.disconnect()
      observing = false
    }
    try {
      mutation()
    } finally {
      if (resume) observe()
    }
  }

  const publish = (role, text) => {
    const target = external[role]
    if (!target) return
    const next = text.trim()
    if (desiredText[role] === next) return
    desiredText[role] = next
    const revision = ++revisions[role]
    target.textContent = ''
    document.defaultView.queueMicrotask(() => {
      if (!active || revisions[role] !== revision) return
      target.textContent = next
    })
  }

  const latestText = (kind) => Array.from(sourcesByKind[kind]).at(-1)?.textContent ?? ''

  const releaseSource = (element) => {
    const state = sourceStates.get(element)
    if (!state) return
    sourcesByKind[state.kind].delete(element)
    mutateSource(() => restoreAttributes(element, state.snapshot))
    sourceStates.delete(element)
    trackedSources.delete(element)
    publish(state.kind, latestText(state.kind))
  }

  const candidateKind = (element) => {
    if (!element.classList.contains('sr-only')) return null
    const state = sourceStates.get(element)
    const currentRole = element.getAttribute('role')
    if (LIVE_KINDS.includes(currentRole)) return currentRole
    if (currentRole !== null) return null
    if (state) return state.kind
    const marker = element.getAttribute(SOURCE_MARKER)
    if (LIVE_KINDS.includes(marker)) return marker
    return null
  }

  const isKnownMogLiveRegion = (element, kind) => {
    if (!kind || !element.closest('[role="grid"]')) return false
    if (sourceStates.has(element)) return element.classList.contains('sr-only')
    const expectedLive = kind === 'alert' ? 'assertive' : 'polite'
    return (
      element.classList.contains('sr-only') &&
      element.getAttribute('aria-live') === expectedLive &&
      element.getAttribute('aria-atomic') === 'true'
    )
  }

  const neutralize = (element) => {
    if (!(element instanceof document.defaultView.HTMLElement)) return
    const kind = candidateKind(element)
    if (!isKnownMogLiveRegion(element, kind)) {
      releaseSource(element)
      return
    }

    let state = sourceStates.get(element)
    if (!state) {
      state = { kind, snapshot: snapshotAttributes(element) }
      sourceStates.set(element, state)
      trackedSources.add(element)
      sourcesByKind[kind].add(element)
    } else if (state.kind !== kind) {
      const previousKind = state.kind
      sourcesByKind[previousKind].delete(element)
      state.kind = kind
      sourcesByKind[kind].add(element)
      publish(previousKind, latestText(previousKind))
    }

    mutateSource(() => {
      element.setAttribute(SOURCE_MARKER, kind)
      element.removeAttribute('role')
      element.removeAttribute('aria-live')
      element.removeAttribute('aria-atomic')
      element.setAttribute('aria-hidden', 'true')
    })
    publish(kind, element.textContent ?? '')
  }

  const scan = (node) => {
    if (!(node instanceof document.defaultView.Element)) return
    if (node.matches(CANDIDATE_SELECTOR) || sourceStates.has(node)) neutralize(node)
    for (const element of node.querySelectorAll(CANDIDATE_SELECTOR)) neutralize(element)
  }

  const releaseTree = (node) => {
    if (!(node instanceof document.defaultView.Element)) return
    if (sourceStates.has(node)) releaseSource(node)
    for (const element of node.querySelectorAll(`[${SOURCE_MARKER}]`)) {
      if (sourceStates.has(element)) releaseSource(element)
    }
  }

  observer = new document.defaultView.MutationObserver((mutations) => {
    // Primero captura el ultimo estado escrito por React. Neutralizar durante
    // este paso borraria atributos que otro record del mismo batch aun debe
    // incorporar al snapshot de cleanup.
    for (const mutation of mutations) {
      if (mutation.type !== 'attributes') continue
      const element = mutation.target
      const state = sourceStates.get(element)
      if (!state || !SNAPSHOT_ATTRIBUTES.includes(mutation.attributeName)) continue
      state.snapshot[mutation.attributeName] = element.getAttribute(mutation.attributeName)
    }

    for (const mutation of mutations) {
      if (mutation.type !== 'childList') continue
      for (const node of mutation.removedNodes) releaseTree(node)
    }

    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        const source = mutation.target.parentElement?.closest(`[${SOURCE_MARKER}]`)
        if (source) neutralize(source)
        continue
      }

      if (mutation.target instanceof document.defaultView.Element) {
        const source = mutation.target.closest(`[${SOURCE_MARKER}]`)
        if (source) neutralize(source)
        scan(mutation.target)
      }
      for (const node of mutation.addedNodes) scan(node)
    }
  })

  scan(root)
  observe()

  const cleanup = () => {
    if (!active) return
    active = false
    for (const kind of LIVE_KINDS) revisions[kind]++
    observer.disconnect()
    observing = false
    bridge.remove()
    for (const element of trackedSources) {
      const state = sourceStates.get(element)
      if (state) restoreAttributes(element, state.snapshot)
      sourceStates.delete(element)
    }
    trackedSources.clear()
    sourcesByKind.status.clear()
    sourcesByKind.alert.clear()
    installations.delete(root)
  }

  installations.set(root, cleanup)
  return cleanup
}

/**
 * Owns BFCache-safe install/cleanup. `ensure()` fails closed while the page is
 * hidden so an async workbook open cannot recreate the bridge after pagehide.
 *
 * @param {HTMLElement} root
 * @param {Window} pageWindow
 */
export function createMogAccessibilityLifecycle(root, pageWindow = root.ownerDocument.defaultView) {
  let pageActive = true
  let disposed = false
  let bridgeCleanup = null
  let activationWait = null

  const ensure = () => {
    if (disposed || !pageActive) return false
    bridgeCleanup ??= installMogAccessibilityBridge(root)
    return true
  }
  const handlePageHide = () => {
    pageActive = false
    bridgeCleanup?.()
    bridgeCleanup = null
  }
  const handlePageShow = () => {
    pageActive = true
    ensure()
    const pending = activationWait
    activationWait = null
    pending?.resolve(true)
  }

  const whenActive = () => {
    if (disposed) return Promise.resolve(false)
    if (pageActive) return Promise.resolve(true)
    if (!activationWait) {
      let resolve
      const promise = new Promise((done) => {
        resolve = done
      })
      activationWait = { promise, resolve }
    }
    return activationWait.promise
  }

  pageWindow.addEventListener('pagehide', handlePageHide)
  pageWindow.addEventListener('pageshow', handlePageShow)
  ensure()

  return {
    ensure,
    whenActive,
    dispose() {
      if (disposed) return
      disposed = true
      pageActive = false
      pageWindow.removeEventListener('pagehide', handlePageHide)
      pageWindow.removeEventListener('pageshow', handlePageShow)
      bridgeCleanup?.()
      bridgeCleanup = null
      const pending = activationWait
      activationWait = null
      pending?.resolve(false)
    },
  }
}

/**
 * Waits without polling until lifecycle can guarantee an installed bridge.
 * The loop only repeats for the narrow pagehide race between a resolved wait
 * and `ensure()`; while hidden the next iteration blocks on one shared promise.
 */
export async function waitForMogPageActive(lifecycle) {
  while (await lifecycle.whenActive()) {
    if (lifecycle.ensure()) return true
  }
  return false
}
