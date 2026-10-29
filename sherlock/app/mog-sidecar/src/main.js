// ============================================================================
// SIDECAR MOG — visor XLSX del VDR
// ============================================================================
// Este bundle NO vive en el bundle de Next: se compila con Vite a
// `sherlock/app/public/mog/` y Next lo sirve como estatico bajo `/mog/`.
//
// Frontera de datos: el sidecar nunca recibe la URL del grant ni ninguna
// credencial. El host (XlsxViewer) descarga los bytes con el grant VIEW,
// abre un MessageChannel y transfiere el ArrayBuffer por el puerto privado.
// Todo el trafico posterior (abrir, navegar, errores) viaja por ese puerto.
// ============================================================================

import { createSpreadsheetRuntime, MogSpreadsheetApp } from '@mog-sdk/spreadsheet-app'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { createMogThemeController } from './theme.js'
import '@mog-sdk/spreadsheet-app/styles.css'
import './accessibility.css'
import { createMogAccessibilityLifecycle, waitForMogPageActive } from './accessibility.js'
import { isHostInit } from './handshake.js'
import { createMogOpenController } from './open-gate.js'
import { installMogPresentation } from './presentation.js'
import { createMogPhaseReporter } from './phases.js'

// `@mog-sdk/spreadsheet-app` instala la consola de DevTools (`window.__dt`:
// maquinas, transiciones, bridge, acciones, control de versiones) como efecto de
// importacion, sin gate de produccion. Los imports ESM se evaluan completos antes
// de esta linea, asi que el borrado es deterministico, no una carrera contra el
// mount. Sigue haciendo falta en 0.10.8-rc.6 (verificado 2026-09-02: `__dt`
// aparece 9 veces en `dist/index.js`); el fix de raiz vive en el fork de Mog.
delete window.__dt

/** @type {MessagePort | null} */
let port = null
/** @type {ReturnType<typeof createSpreadsheetRuntime> | null} */
let runtimePromise = null
/** @type {import('@mog-sdk/spreadsheet-app').SpreadsheetAppAttachmentHandle | null} */
let appHandle = null
/** @type {{ sheet?: string, range?: string } | null} */
let pendingNavigation = null

const root = document.getElementById('root')
if (!root) throw new Error('Mog sidecar root is missing')
const accessibilityLifecycle = createMogAccessibilityLifecycle(root, window)
installMogPresentation(root)
/** @type {import('react-dom/client').Root | null} */
let reactRoot = null
/** @type {import('@mog-sdk/spreadsheet-app').MogSpreadsheetAppProps | null} */
let appProps = null
function renderApp() {
  if (reactRoot && appProps) {
    reactRoot.render(createElement(MogSpreadsheetApp, { ...appProps, theme: theme.policy() }))
  }
}
const theme = createMogThemeController(document, renderApp)

/** @param {unknown} data */
function applyThemeMessage(data) {
  if (data && typeof data === 'object' && 'theme' in data) theme.accept(data.theme)
}

function post(message) {
  port?.postMessage(message)
}

function failure(error) {
  const message = error instanceof Error ? error.message : String(error)
  post({ type: 'error', message, at: Math.round(performance.now()) })
}

// Marcas de fase: el host las usa para que el esqueleto diga en que va, y las
// marcas `performance` heredadas siguen intactas para la spec de perf. La tabla
// y el porque viven en `phases.js`.
const phase = createMogPhaseReporter({
  post,
  now: () => performance.now(),
  mark: (name) => performance.mark(name),
})

function loadRuntime() {
  if (!runtimePromise) {
    // Sin `assets`: Vite emite el `.wasm` y las fuentes dentro del grafo del
    // bundle (`/mog/assets/*`), asi que el runtime los resuelve con `base`.
    runtimePromise = createSpreadsheetRuntime({
      // El VDR es la fuente de custodia: el sidecar jamas persiste el libro.
      onSaveRequest: async () => ({ status: 'skipped' }),
    })
  }
  return runtimePromise
}

/** @param {{ sheet?: string, range?: string } | null} navigation */
async function applyNavigation(navigation) {
  if (!appHandle || !navigation) return
  await appHandle.ready
  const view = appHandle.view()
  if (navigation.range) {
    await view.select({ sheet: navigation.sheet, range: navigation.range })
    return
  }
  if (navigation.sheet) {
    await view.setActiveSheet(navigation.sheet)
  }
}

async function openWorkbook({ bytes, fileName, workbookId }, attempt) {
  phase('bytes-received')
  const runtime = await loadRuntime()
  await runtime.ready
  phase('wasm-ready')
  phase('parsing')
  const workbook = await runtime.openWorkbook({
    workbookId,
    displayName: fileName,
    source: { kind: 'xlsx-bytes', bytes, fileName },
  })
  await workbook.ready
  phase('first-sheet')

  // Conserva runtime/workbook ya abiertos, pero espera pageshow antes del
  // unico mount si pagehide ocurrio durante cualquiera de los awaits.
  if (!(await waitForMogPageActive(accessibilityLifecycle))) {
    attempt.fail()
    return
  }
  if (!attempt.isCurrent()) return
  root.textContent = ''
  reactRoot ??= createRoot(root)
  appProps = {
    runtime,
    workbook,
    // Solo lectura: el VDR custodia la version, el visor no la edita.
    editModel: { user: 'read' },
    chrome: { commandBar: false, formulaBar: true, sheetTabs: true, statusBar: true },
    onReady: (handle) => {
      appHandle = handle
      phase('rendered')
      if (!attempt.markOpened()) return
      post({ type: 'opened' })
      if (pendingNavigation) {
        const navigation = pendingNavigation
        pendingNavigation = null
        applyNavigation(navigation).catch(failure)
      }
    },
    onError: (error) => {
      if (attempt.handleFailure() === 'report') failure(error)
    },
  }
  renderApp()
}

const openController = createMogOpenController({
  open: openWorkbook,
  onFailure: failure,
})

function handlePortMessage(event) {
  const data = event.data
  if (!data || typeof data !== 'object') return

  if (data.type === 'theme') {
    applyThemeMessage(data)
    return
  }

  if (data.type === 'open') {
    openController.accept(data)
    return
  }

  if (data.type === 'navigate') {
    const navigation = { sheet: data.sheet, range: data.range }
    if (!appHandle) {
      pendingNavigation = navigation
      return
    }
    applyNavigation(navigation).catch(failure)
  }
}

// Apretón de manos: el host envia `mog:init` con el puerto privado. El sidecar
// responde `ready` por ese puerto y a partir de ahi no vuelve a usar
// `window.postMessage` — el canal es privado y no observable por terceros.
//
// El primer puerto sella el canal y `isHostInit` decide quien puede entregarlo:
// ventana padre y mismo origen (`handshake.js`).
window.addEventListener('message', (event) => {
  if (port) return
  if (!isHostInit(event, window)) return
  applyThemeMessage(event.data)
  port = event.ports[0]
  port.onmessage = handlePortMessage
  port.start()
  post({ type: 'ready' })
  phase('boot')
})

// El host no sabe cuando termina de evaluarse este modulo, y el modulo puede
// terminar ANTES de que el host tenga los bytes y ponga su listener. Por eso el
// saludo se repite hasta que llegue el puerto. El aviso no transporta nada del
// documento: solo pide el canal privado.
const hello = window.setInterval(() => {
  if (port) {
    window.clearInterval(hello)
    return
  }
  window.parent?.postMessage({ type: 'mog:hello' }, window.location.origin)
}, 250)
window.setTimeout(() => window.clearInterval(hello), 60_000)
window.parent?.postMessage({ type: 'mog:hello' }, window.location.origin)
