import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// El sitio ships solo en español ([F] 2026-09-03 23:30): la paridad es/en que
// vivía en `i18n-visible-copy-contract.test.ts` murió con el locale `en`, pero
// los guardas que ese archivo cargaba encima no dependían de dos idiomas. Aquí
// siguen vivos, sin la paridad: un solo idioma no es excusa para dejar que la
// copia visible se escape del catálogo o del componente que la traduce.

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const APP_ROOT = path.resolve(PROJECT_ROOT, '..')
const LOCALE_APP_ROOT = path.join(APP_ROOT, 'src/app/[locale]')

function walkFiles(root: string, filename: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) return walkFiles(absolute, filename)
    return entry.name === filename ? [absolute] : []
  })
}

function walkComponentSources(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name)
    if (entry.isDirectory()) return walkComponentSources(absolute)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [absolute] : []
  })
}

// `toLocaleString` sobre un número es formato de cifra, no de fecha. Cada
// entrada necesita su razón; la lista puede encoger, y sumarle un archivo es
// afirmar que ahí no se formatea ninguna fecha.
const NUMBER_FORMAT_ALLOWLIST: Record<string, string> = {
  'src/components/ui/chart.tsx': 'formatea el número del tooltip, no una fecha',
  'src/components/vdr-guest/GuestAuthorizedRoom.tsx':
    'formatea el valor numérico de un widget, no una fecha',
}

// El receptor no importa y la llamada puede partirse en varias líneas: el
// detector corre sobre el archivo entero, no línea por línea, porque
// `const creado = new Date(x)` arriba y `creado.toLocaleDateString('es-PA')`
// abajo es exactamente el mismo defecto.
const LOCALE_DATE_CALL = /\.\s*toLocale(?:String|DateString|TimeString)\s*\(/g

// `dateStyle` y `timeStyle` son el otro portillo: `new Intl.DateTimeFormat(locale,
// { dateStyle: 'medium', timeStyle: 'short' })` imprime en la zona del navegador
// y en un formato distinto al de los helpers, así que una misma pantalla mostraba
// dos convenciones ([F] 2026-09-17). La clave también puede venir entre comillas
// (`'dateStyle':`) o calculada (`['timeStyle']:`), y es el mismo defecto.
const DATE_STYLE_OPTION = /\b(?:dateStyle|timeStyle)\b['"`]?\s*\]?\s*:/g

function matchLines(contents: string, pattern: RegExp): number[] {
  return [...contents.matchAll(pattern)].map(
    (match) => contents.slice(0, match.index).split('\n').length
  )
}

function localeDateCallLines(contents: string): number[] {
  return matchLines(contents, LOCALE_DATE_CALL)
}

function dateStyleOptionLines(contents: string): number[] {
  return matchLines(contents, DATE_STYLE_OPTION)
}

function source(relativePath: string): string {
  return fs.readFileSync(path.join(APP_ROOT, relativePath), 'utf8')
}

describe('visible-copy contract (es-only)', () => {
  it('routes every retained localized error boundary through one translated component', () => {
    const errorFiles = walkFiles(LOCALE_APP_ROOT, 'error.tsx')
    expect(errorFiles.length).toBeGreaterThan(0)

    const violations = errorFiles
      .filter(
        (file) => !fs.readFileSync(file, 'utf8').includes('@/components/errors/RouteErrorBoundary')
      )
      .map((file) => path.relative(APP_ROOT, file))

    expect(violations).toEqual([])
  })

  it('keeps the admin shell on preparation and VDR operations copy', () => {
    const adminPage = source('src/app/[locale]/(app)/admin/page.tsx')

    // La página carga la copia por `loadAdminTranslations(locale, 'admin.operations')`
    // (ola 2 de Effect, 82711999b); el pin es el namespace, no la forma de la llamada.
    expect(adminPage).toMatch(/(namespace: |loadAdminTranslations\(locale, )'admin\.operations'/)
    expect(adminPage).not.toMatch(/marketplace opportunities|Gestiona usuarios, deals/i)
  })

  it('keeps admin analytics payloads free of locale formatting at the Convex boundary', () => {
    const backendSources = [
      source('convex/_analytics/admin.ts'),
      source('convex/_analytics/shared.ts'),
    ].join('\n')

    // Convex devuelve el dato; el formato de fecha es del cliente, que conoce la
    // zona horaria del visitante. Formatear acá también reimportaría la copia
    // del marketplace por la puerta de atrás.
    expect(backendSources).not.toMatch(/toLocaleDateString\(['"]es-/)
    expect(backendSources).not.toMatch(
      /\b(?:Deals Activos|Expresiones de Interés|Conexiones Exitosas|Conexión establecida|Empresa e inversionista conectados)\b/
    )
  })

  // `Intl` en es-PA ordena MM/DD/YYYY, así que una fecha formateada a mano se
  // lee como estadounidense: el historial de versiones decía «09/13/2026»
  // ([F] 2026-09-17, hallazgos del E2E). Los formateadores compartidos de
  // `src/lib/utils.ts` fijan día, mes abreviado, año, reloj de 24 h y UTC, que
  // es lo que ya usa la tabla de actividad del Data Room: así el mismo evento
  // dice la misma hora en las dos pantallas.
  it('formats every visible date in src/components through the shared formatters', () => {
    const componentsRoot = path.join(APP_ROOT, 'src/components')
    const files = walkComponentSources(componentsRoot)
    expect(files.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const file of files) {
      const relative = path.relative(APP_ROOT, file).split(path.sep).join('/')
      if (relative in NUMBER_FORMAT_ALLOWLIST) continue

      const contents = fs.readFileSync(file, 'utf8')
      for (const line of localeDateCallLines(contents)) {
        offenders.push(`${relative}:${line}`)
      }
      for (const line of dateStyleOptionLines(contents)) {
        offenders.push(`${relative}:${line}`)
      }
    }

    expect(offenders).toEqual([])
  })

  // La zona tiene que ser fija y nombrada: fija para que servidor y navegador
  // impriman la misma cadena (hidratación), y la de Panamá para que el día sea
  // el que el cliente vivió. UTC cumplía lo primero y fallaba lo segundo.
  it('pins the shared formatters to America/Panama', () => {
    const utils = source('src/lib/utils.ts')

    expect(utils).toContain('America/Panama')
    expect(utils).not.toMatch(/timeZone:\s*'UTC'/)
  })

  // El detector es el candado, así que él también se prueba: las tres formas
  // que un arreglo anterior dejaba pasar.
  it('catches a stored Date receiver and a call split across lines', () => {
    expect(localeDateCallLines("new Date(value).toLocaleString('es-PA')")).toEqual([1])
    expect(
      localeDateCallLines("const creado = new Date(value)\ncreado.toLocaleDateString('es-PA')")
    ).toEqual([2])
    expect(
      localeDateCallLines('const creado = new Date(value)\ncreado\n  .toLocaleTimeString()')
    ).toEqual([3])
    expect(
      localeDateCallLines('const creado = new Date(value)\ncreado.\n  toLocaleString()')
    ).toEqual([2])
    expect(localeDateCallLines('formatShortDate(value, locale)')).toEqual([])
  })

  it('catches a dateStyle or timeStyle formatter and lets the shared helper pass', () => {
    expect(
      dateStyleOptionLines("new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })")
    ).toEqual([1])
    expect(
      dateStyleOptionLines("new Intl.DateTimeFormat(locale, {\n  timeStyle: 'short',\n})")
    ).toEqual([2])
    expect(
      dateStyleOptionLines("new Intl.DateTimeFormat(locale, { 'dateStyle': 'medium' })")
    ).toEqual([1])
    expect(
      dateStyleOptionLines("new Intl.DateTimeFormat(locale, { ['timeStyle']: 'short' })")
    ).toEqual([1])
    expect(dateStyleOptionLines('formatDateTime(value, locale)')).toEqual([])
  })
})
