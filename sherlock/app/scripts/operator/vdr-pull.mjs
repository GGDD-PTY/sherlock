#!/usr/bin/env node
// ============================================================================
// VDR PULL (operador)
// ============================================================================
// Baja los documentos vigentes de UNA empresa a una carpeta local, con la misma
// estructura de carpetas que el cliente ve en su sala. Es la mitad de entrada
// del ciclo manual de Mycroft; la de salida es `vdr-push.mjs`.
//
//   <out>/<slug>__<companyId>/<room_folder_key>/<nombre original>
//
// Su única superficie Convex es `operatorDeliverables:*`, toda `internal*` y por
// lo tanto solo alcanzable con la deploy key del deployment.
//
// Uso:
//   bun --cwd=sherlock/app run vdr:pull -- --company "Sample Hydro"
//   bun --cwd=sherlock/app run vdr:pull -- --company <companyId> --out ~/tmp/inbox
//   bun --cwd=sherlock/app run vdr:pull -- --company <companyId> --force
//   bun --cwd=sherlock/app run vdr:pull -- --company "Sintética Uno, S. A." --deployment local
// ============================================================================

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXIT_FAILED,
  EXIT_REFUSED,
  OperatorCliError,
  resolveDeployment,
  restoreEnvLocal,
  runOperatorFunction as runConvexFunction,
} from './convex-deployment.mjs'

function log(message) {
  process.stdout.write(`[vdr-pull] ${message}\n`)
}

function fail(message, code = EXIT_FAILED) {
  process.stderr.write(`[vdr-pull] ${message}\n`)
  process.exit(code)
}

async function orFail(action) {
  try {
    const result = await action()
    return result
  } catch (error) {
    if (error instanceof OperatorCliError) fail(error.message, error.code)
    throw error
  }
}

function parseArgs(argv) {
  const options = {
    company: null,
    deployment: 'dev',
    force: false,
    out: join(homedir(), 'Developer/mycroft-taller/inbox'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--force') {
      options.force = true
      continue
    }
    if (arg === '--company') {
      options.company = argv[++index] ?? null
      continue
    }
    if (arg === '--deployment') {
      options.deployment = argv[++index] ?? null
      continue
    }
    if (arg === '--out') {
      options.out = argv[++index] ?? options.out
      continue
    }
    fail(`argumento desconocido: ${arg}`, EXIT_REFUSED)
  }
  if (!options.company) {
    fail('falta --company <companyId|nombre exacto>', EXIT_REFUSED)
  }
  return options
}

function slugify(value) {
  return (
    (value ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/g, '') || 'empresa'
  )
}

// La sala muestra nombres SIN extensión (`INA_SAMPLE_ENERGY_2022_FY_v01`). Mycroft
// filtra sus insumos por extensión, así que un archivo sin ella no lo ve.
const EXTENSION_BY_MIME = new Map([
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/vnd.ms-excel', '.xls'],
  ['text/csv', '.csv'],
  ['text/plain', '.txt'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
])

function withExtension(name, mimeType) {
  if (extname(name)) return name
  const extension = EXTENSION_BY_MIME.get((mimeType ?? '').split(';')[0].trim())
  return extension ? `${name}${extension}` : name
}

// Índice sha -> ruta de TODO lo que ya está en la carpeta de la empresa. Mirar
// solo la ruta esperada volvía a bajar un documento renombrado o movido en la
// sala; con el índice, los bytes que ya están en disco no se vuelven a pedir.
function buildLocalShaIndex(directory) {
  const index = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (entry.name === 'manifest.json') continue
      index.set(sha256Of(readFileSync(full)), full)
    }
  }
  if (existsSync(directory)) walk(directory)
  return index
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function safeSegment(value) {
  return (value ?? '').replace(/[/\\]/g, '_').replace(/^\.+/, '').trim()
}

function readPreviousManifest(path) {
  if (!existsSync(path)) return new Map()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return new Map((parsed?.documents ?? []).map((row) => [row.versionId, row]))
  } catch {
    return new Map()
  }
}

export function fileSize(path) {
  try {
    return statSync(path).size
  } catch {
    return null
  }
}

// Digest hex de un archivo local sin cargarlo entero en memoria: los libros
// de una sala pasan de los 10 MB y esto corre por cada fila del manifiesto.
export function fileSha256(path) {
  try {
    const hash = createHash('sha256')
    const descriptor = openSync(path, 'r')
    try {
      const chunk = Buffer.allocUnsafe(1 << 20)
      let bytesRead = readSync(descriptor, chunk, 0, chunk.length, null)
      while (bytesRead > 0) {
        hash.update(chunk.subarray(0, bytesRead))
        bytesRead = readSync(descriptor, chunk, 0, chunk.length, null)
      }
    } finally {
      closeSync(descriptor)
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

// `listCompanyDocuments` ya normaliza el digest de la sala a hex; lo que llega
// en otra forma es una fila vieja (base64) que el servidor no pudo probar, y
// contra eso no hay bytes locales que comparar.
function sha256HexOrNull(value) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return /^[a-fA-F0-9]{64}$/.test(trimmed) ? trimmed.toLowerCase() : null
}

/**
 * Qué versiones NO hay que volver a pedirle a Convex. Cada blob que el pull
 * vuelve a bajar puede consumir transferencia, así que se reutilizan los bytes
 * locales cuando el digest y el tamaño coinciden.
 *
 * Se reusa un archivo solo cuando sus BYTES son los de la sala: el sha del
 * manifiesto y el tamaño son el filtro barato, y el digest del archivo local
 * es la prueba. Sin esa prueba, un libro editado a mano con el mismo tamaño
 * (un xlsx tocado en Excel, una celda cambiada) pasaba por bytes de la sala y
 * Mycroft corría sobre un insumo que el cliente nunca subió. Una fila cuyo
 * digest remoto no se puede llevar a hex (base64 viejo) se vuelve a bajar:
 * cuesta egress una vez y a cambio el manifiesto queda probado.
 */
export function planFromManifest({ documents, previous, sizeOf, digestOf, force = false }) {
  const reuse = new Map()
  const pending = []
  for (const document of documents) {
    const row = force ? undefined : previous.get(document.versionId)
    const remoteSha = sha256HexOrNull(document.sha256)
    if (
      row &&
      remoteSha !== null &&
      row.sha256 === document.sha256 &&
      typeof row.relativePath === 'string' &&
      sizeOf(row.relativePath) === document.byteSize &&
      digestOf(row.relativePath) === remoteSha
    ) {
      reuse.set(document.versionId, row.relativePath)
      continue
    }
    pending.push(document)
  }
  return { reuse, pending }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const target = await orFail(() => resolveDeployment({ deployment: options.deployment }))
  log(`deployment ${target.deployment}`)

  const resolved = await orFail(() =>
    runConvexFunction(target, 'operatorDeliverables:resolveCompany', { query: options.company })
  )
  const matches = resolved?.matches ?? []
  if (matches.length === 0) {
    fail(`ninguna empresa coincide con "${options.company}"`, EXIT_REFUSED)
  }
  if (matches.length > 1) {
    process.stderr.write(
      `[vdr-pull] "${options.company}" coincide con ${matches.length} empresas:\n`
    )
    for (const match of matches) {
      process.stderr.write(`[vdr-pull]   ${match.companyId}  ${match.name}\n`)
    }
    fail('pasa el companyId exacto en --company', EXIT_REFUSED)
  }

  const company = matches[0]
  // El companyId en el nombre de la carpeta ES la garantía anti-mezcla: dos
  // clientes que se llamen parecido (o igual) nunca comparten directorio, y el
  // operador puede leer de qué sala salió cada archivo sin abrir el manifiesto.
  const companyDirectory = join(options.out, `${slugify(company.name)}__${company.companyId}`)
  mkdirSync(companyDirectory, { recursive: true })

  const manifestPath = join(companyDirectory, 'manifest.json')
  const previous = readPreviousManifest(manifestPath)

  const page = await orFail(() =>
    runConvexFunction(target, 'operatorDeliverables:listCompanyDocuments', {
      companyId: company.companyId,
    })
  )
  const documents = page?.documents ?? []

  let downloaded = 0
  let skipped = 0
  const manifestDocuments = []

  const { reuse, pending } = planFromManifest({
    documents,
    previous,
    sizeOf: (relativePath) => fileSize(join(companyDirectory, relativePath)),
    digestOf: (relativePath) => fileSha256(join(companyDirectory, relativePath)),
    force: options.force,
  })

  // El índice por sha es el respaldo de lo que el manifiesto no explica (una
  // carpeta bajada por una versión anterior del script, un documento que la
  // sala renombró o movió). Construirlo lee y hashea la carpeta entera, así que
  // una corrida sin novedades no lo paga.
  const localBySha =
    pending.length > 0 && !options.force ? buildLocalShaIndex(companyDirectory) : new Map()

  const claimed = new Set()

  for (const document of documents) {
    const previousRow = previous.get(document.versionId)
    const reusedRelative = reuse.get(document.versionId)
    let path
    let reused = true

    if (reusedRelative) {
      path = join(companyDirectory, reusedRelative)
    } else {
      const folderDirectory = join(companyDirectory, safeSegment(document.shellFolder))
      mkdirSync(folderDirectory, { recursive: true })

      const baseName = withExtension(
        safeSegment(document.name) || document.sha256.slice(0, 8),
        document.detectedMimeType
      )
      const existingPath = localBySha.get(document.sha256)

      if (existingPath) {
        path = existingPath
      } else {
        reused = false
        path = join(folderDirectory, baseName)
        // La copia anterior de ESTA versión se pisa en su sitio; el rename solo
        // aparta el nombre cuando lo ocupa OTRO documento. Sin esa distinción,
        // `--force` dejaba un duplicado por archivo en cada corrida.
        const ownPath = previousRow?.relativePath
          ? join(companyDirectory, previousRow.relativePath)
          : null
        if (claimed.has(path) || (existsSync(path) && path !== ownPath)) {
          path = join(folderDirectory, `${document.sha256.slice(0, 8)}-${baseName}`)
        }
        if (!document.url) {
          fail(`la versión ${document.versionId} no tiene URL de storage`)
        }
        const response = await fetch(document.url)
        if (!response.ok) {
          fail(`descarga fallida (${response.status}) para ${document.name}`)
        }
        writeFileSync(path, Buffer.from(await response.arrayBuffer()))
        localBySha.set(document.sha256, path)
        downloaded += 1
        log(`${document.shellFolder}/${baseName}`)
      }
    }

    if (reused) skipped += 1
    claimed.add(path)

    manifestDocuments.push({
      documentId: document.documentId,
      versionId: document.versionId,
      name: document.name,
      folder: document.folder,
      shellFolder: document.shellFolder,
      sha256: document.sha256,
      byteSize: document.byteSize,
      relativePath: relative(companyDirectory, path),
      downloadedAt: reused
        ? (previousRow?.downloadedAt ?? new Date().toISOString())
        : new Date().toISOString(),
    })
  }

  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        companyId: company.companyId,
        companyName: page?.companyName ?? company.name,
        deployment: target.deployment,
        generatedAt: new Date().toISOString(),
        documents: manifestDocuments,
      },
      null,
      2
    )}\n`
  )

  log(`${company.name} -> ${companyDirectory}`)
  log(`descargados ${downloaded}, omitidos ${skipped}`)
}

// Importar el módulo no puede correr el pull: los tests cargan `planFromManifest`
// desde acá, y sin este guard `main()` se comía el proceso de vitest.
const isDirectRun =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isDirectRun) {
  try {
    await main()
  } finally {
    restoreEnvLocal()
  }
}
