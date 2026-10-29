// ============================================================================
// UPLOAD HANDOFF — EL PROGRAMA EFFECT SOBRE INDEXEDDB
// ============================================================================
// IndexedDB is only loss-resistant browser continuity across hosted auth. Durable
// custody is established by the intake/VDR backend; records are removed only after
// that backend confirms success (or after the explicit TTL policy expires them).
// One parked intake = the selected files plus the company name typed on the
// landing. Both travel under the same TTL and are acknowledged separately,
// because each one is consumed by a different confirmation in the room.
//
// EL HANDLE DE INDEXEDDB VIVE EN UN SCOPE. Cada operación abre la base con
// `Effect.acquireUseRelease`, así que `db.close()` corre por el `release` pase lo
// que pase — éxito, fallo tipado, timeout o interrupción. Antes lo sostenía un
// `finally`, que no cubre una cota de tiempo. Los accesos a la base entran por
// `externalCall`: llevan span, error tipado y techo de tiempo, y sin reintentos
// porque una transacción reintentada escribiría dos veces.
//
// El borde de cada función exportada es `runServerEffect` con `Effect.match`:
// las firmas Promise que consume React no cambian y ningún fallo sale de acá.
//
// ===== POR QUÉ VIVE APARTE DE `upload-handoff.ts` ([F] 2026-09-08) =====
// Las seis funciones las llaman componentes `'use client'` — la landing, el
// workspace temporal y la sala de documentos. Tener el programa en el mismo
// módulo metía `effect` y el runtime de fibras en su first-load JS. Las seis ya
// eran `async`, así que la fachada las difiere con `import()` sin cambiarle la
// firma a nadie; el comportamiento es idéntico.

import { Effect } from 'effect'

import { UnexpectedAppError } from '@/lib/effect/errors'
import { externalCall } from '@/lib/effect/external'
import { runServerEffect } from '@/lib/effect/runtime'
import {
  HANDOFF_TTL_MS,
  type HandoffFile,
  type HandoffFileId,
  type HandoffPeekResult,
  type HandoffStash,
} from '@/lib/mycroft/upload-handoff'

const DB_NAME = 'sherlock-mycroft-handoff'
const DB_VERSION = 2
const FILE_STORE = 'files'
const INTAKE_STORE = 'intake'
const COMPANY_NAME_KEY = 'companyName'

const HANDOFF_MAX_COMPANY_NAME_LENGTH = 120

// Cotas holgadas a propósito: acá no se compite contra un usuario esperando,
// sino contra una base bloqueada por otra pestaña o una transacción que nunca
// asienta. Sin ellas la promesa del caller no se resuelve nunca.
const HANDOFF_OPEN_TIMEOUT_MS = 10_000
const HANDOFF_TRANSACTION_TIMEOUT_MS = 30_000

type StashedRecord = {
  id: HandoffFileId
  name: string
  type: string
  lastModified: number
  // Raw bytes instead of Blob: structured cloning Blob differs across browsers.
  bytes: ArrayBuffer
  stashedAt: number
  nonce?: string
}

type StashedCompanyName = {
  key: typeof COMPANY_NAME_KEY
  name: string
  stashedAt: number
  nonce: string
}

const UNAVAILABLE_HANDOFF: HandoffPeekResult = {
  status: 'UNAVAILABLE',
  files: [],
  companyName: null,
  stashedAt: null,
  nonce: null,
}

function getFactory(): IDBFactory | null {
  if (typeof globalThis === 'undefined') return null
  return globalThis.indexedDB ?? null
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(INTAKE_STORE)) {
        db.createObjectStore(INTAKE_STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('handoff db open failed'))
    request.onblocked = () => reject(new Error('handoff db blocked'))
  })
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('handoff tx failed'))
    tx.onabort = () => reject(tx.error ?? new Error('handoff tx aborted'))
  })
}

function readAll(store: IDBObjectStore): Promise<StashedRecord[]> {
  return new Promise((resolve, reject) => {
    const request = store.getAll()
    request.onsuccess = () => resolve(request.result as StashedRecord[])
    request.onerror = () => reject(request.error ?? new Error('handoff read failed'))
  })
}

// A record outlives the code that wrote it: an older schema, a half-applied
// upgrade or a foreign write all surface here. An unparseable record is treated
// as no name, so the room is never renamed from a shape we cannot vouch for.
function parseStashedCompanyName(value: unknown): StashedCompanyName | null {
  if (typeof value !== 'object' || value === null) return null
  if (!('key' in value) || value.key !== COMPANY_NAME_KEY) return null
  if (!('name' in value) || typeof value.name !== 'string') return null
  if (!('stashedAt' in value) || typeof value.stashedAt !== 'number') return null
  if (!('nonce' in value) || typeof value.nonce !== 'string') return null
  return { key: COMPANY_NAME_KEY, name: value.name, stashedAt: value.stashedAt, nonce: value.nonce }
}

function parseRecordNonce(record: StashedRecord): string | null {
  return typeof record.nonce === 'string' && record.nonce ? record.nonce : null
}

function readCompanyName(store: IDBObjectStore): Promise<StashedCompanyName | null> {
  return new Promise((resolve, reject) => {
    const request = store.get(COMPANY_NAME_KEY)
    request.onsuccess = () => resolve(parseStashedCompanyName(request.result))
    request.onerror = () => reject(request.error ?? new Error('handoff name read failed'))
  })
}

function normalizeCompanyName(value: string | null | undefined): string | null {
  const name = value?.trim().slice(0, HANDOFF_MAX_COMPANY_NAME_LENGTH).trim()
  return name ? name : null
}

function toHandoffFile(record: StashedRecord): HandoffFile {
  return {
    id: record.id,
    file: new File([record.bytes], record.name, {
      type: record.type,
      lastModified: record.lastModified,
    }),
  }
}

// ============================================================================
// PUENTE A EFFECT
// ============================================================================

/** Una llamada a la base del navegador: span, error tipado y cota de tiempo. */
function handoffStoreCall<A>(
  operation: string,
  run: () => Promise<A>,
  timeout: number = HANDOFF_TRANSACTION_TIMEOUT_MS
) {
  return externalCall({
    service: 'IndexedDB',
    operation: `handoff.${operation}`,
    timeout,
    // Una transacción reintentada volvería a escribir o a borrar: una sola
    // tentativa, y el caller decide qué hacer con el fallo.
    retries: 0,
    run,
  })
}

/** `db.transaction()` tira sincrónicamente si falta un store. */
function openTransaction(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode) {
  return Effect.try({
    try: () => db.transaction(stores, mode),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'uploadHandoff.openTransaction',
        message: 'No se pudo abrir la transacción del sobre de handoff.',
        cause,
      }),
  })
}

/**
 * EL SCOPE. `release` cierra el handle con el `Exit` en la mano, así que corre
 * igual si `use` falló, si venció la cota de tiempo o si alguien interrumpió la
 * fibra. Un handle abierto bloquea el `onupgradeneeded` de la pestaña siguiente.
 */
function withHandoffDb<A, E>(factory: IDBFactory, use: (db: IDBDatabase) => Effect.Effect<A, E>) {
  return Effect.acquireUseRelease(
    handoffStoreCall('open', () => openDb(factory), HANDOFF_OPEN_TIMEOUT_MS),
    use,
    (db) => Effect.sync(() => db.close())
  )
}

// ============================================================================
// OPERACIONES
// ============================================================================

const stashHandoffEffect = Effect.fn('UploadHandoff.stash')(function* (
  factory: IDBFactory,
  { files, companyName, nonce }: HandoffStash
) {
  const normalizedName = normalizeCompanyName(companyName)
  const payloads = yield* Effect.tryPromise({
    try: () => Promise.all(files.map((file) => file.arrayBuffer())),
    catch: (cause) =>
      new UnexpectedAppError({
        operation: 'uploadHandoff.readSelectionBytes',
        message: 'No se pudieron leer los bytes de la selección.',
        cause,
      }),
  })

  return yield* withHandoffDb(
    factory,
    Effect.fn('UploadHandoff.stash.write')(function* (db: IDBDatabase) {
      const tx = yield* openTransaction(db, [FILE_STORE, INTAKE_STORE], 'readwrite')
      const fileStore = tx.objectStore(FILE_STORE)
      const intakeStore = tx.objectStore(INTAKE_STORE)
      fileStore.clear()
      intakeStore.delete(COMPANY_NAME_KEY)
      const stashedAt = Date.now()
      files.forEach((file, index) => {
        fileStore.put({
          id: index,
          name: file.name,
          type: file.type,
          lastModified: file.lastModified,
          bytes: payloads[index],
          stashedAt,
          nonce,
        } satisfies StashedRecord)
      })
      if (normalizedName) {
        intakeStore.put({
          key: COMPANY_NAME_KEY,
          name: normalizedName,
          stashedAt,
          nonce,
        } satisfies StashedCompanyName)
      }
      yield* handoffStoreCall('stash', () => awaitTransaction(tx))
      return true
    })
  )
})

const peekHandoffEffect = Effect.fn('UploadHandoff.peek')(function* (factory: IDBFactory) {
  return yield* withHandoffDb(
    factory,
    Effect.fn('UploadHandoff.peek.read')(function* (db: IDBDatabase) {
      const tx = yield* openTransaction(db, [FILE_STORE, INTAKE_STORE], 'readwrite')
      const fileStore = tx.objectStore(FILE_STORE)
      const intakeStore = tx.objectStore(INTAKE_STORE)
      const [records, storedName] = yield* handoffStoreCall('peek.read', () =>
        Promise.all([readAll(fileStore), readCompanyName(intakeStore)])
      )

      const now = Date.now()
      let companyName: string | null = null
      // Solo lo que sobrevive lleva reloj y llave: un registro expirado ya no
      // puede fechar ni abrir nada, y el nombre y los bytes de una misma tanda
      // comparten hora y nonce. Manda la tanda más reciente.
      let stashedAt: number | null = null
      let nonce: string | null = null
      const keepLatest = (value: number, recordNonce: string | null) => {
        if (stashedAt !== null && value <= stashedAt) return
        stashedAt = value
        nonce = recordNonce
      }
      if (storedName !== null) {
        if (now - storedName.stashedAt > HANDOFF_TTL_MS) {
          intakeStore.delete(COMPANY_NAME_KEY)
        } else {
          companyName = normalizeCompanyName(storedName.name)
          if (companyName) keepLatest(storedName.stashedAt, storedName.nonce)
        }
      }

      if (records.length === 0) {
        yield* handoffStoreCall('peek.settleEmpty', () => awaitTransaction(tx))
        return { status: 'EMPTY', files: [], companyName, stashedAt, nonce } as HandoffPeekResult
      }

      const active: StashedRecord[] = []
      let expired = false
      for (const record of records) {
        if (now - record.stashedAt > HANDOFF_TTL_MS) {
          expired = true
          fileStore.delete(record.id)
        } else {
          active.push(record)
          keepLatest(record.stashedAt, parseRecordNonce(record))
        }
      }
      yield* handoffStoreCall('peek.settle', () => awaitTransaction(tx))

      if (active.length === 0) {
        return {
          status: expired ? 'EXPIRED' : 'EMPTY',
          files: [],
          companyName,
          stashedAt,
          nonce,
        } as HandoffPeekResult
      }
      return {
        status: 'READY',
        files: active.sort((left, right) => left.id - right.id).map(toHandoffFile),
        companyName,
        stashedAt: active.reduce((latest, record) => Math.max(latest, record.stashedAt), 0),
        nonce,
      } as HandoffPeekResult
    })
  )
})

const ackHandoffFilesEffect = Effect.fn('UploadHandoff.ackFiles')(function* (
  factory: IDBFactory,
  uniqueIds: readonly HandoffFileId[]
) {
  return yield* withHandoffDb(
    factory,
    Effect.fn('UploadHandoff.ackFiles.write')(function* (db: IDBDatabase) {
      const tx = yield* openTransaction(db, FILE_STORE, 'readwrite')
      const store = tx.objectStore(FILE_STORE)
      for (const id of uniqueIds) store.delete(id)
      yield* handoffStoreCall('ackFiles', () => awaitTransaction(tx))
      return true
    })
  )
})

const discardHandoffWithNonceEffect = Effect.fn('UploadHandoff.discardWithNonce')(function* (
  factory: IDBFactory,
  nonce: string
) {
  return yield* withHandoffDb(
    factory,
    Effect.fn('UploadHandoff.discardWithNonce.write')(function* (db: IDBDatabase) {
      const tx = yield* openTransaction(db, [FILE_STORE, INTAKE_STORE], 'readwrite')
      const fileStore = tx.objectStore(FILE_STORE)
      const intakeStore = tx.objectStore(INTAKE_STORE)
      const [records, storedName] = yield* handoffStoreCall('discardWithNonce.read', () =>
        Promise.all([readAll(fileStore), readCompanyName(intakeStore)])
      )
      for (const record of records) {
        if (parseRecordNonce(record) === nonce) fileStore.delete(record.id)
      }
      if (storedName?.nonce === nonce) intakeStore.delete(COMPANY_NAME_KEY)
      yield* handoffStoreCall('discardWithNonce', () => awaitTransaction(tx))
      return true
    })
  )
})

const discardHandoffEffect = Effect.fn('UploadHandoff.discard')(function* (factory: IDBFactory) {
  return yield* withHandoffDb(
    factory,
    Effect.fn('UploadHandoff.discard.write')(function* (db: IDBDatabase) {
      const tx = yield* openTransaction(db, [FILE_STORE, INTAKE_STORE], 'readwrite')
      tx.objectStore(FILE_STORE).clear()
      tx.objectStore(INTAKE_STORE).delete(COMPANY_NAME_KEY)
      yield* handoffStoreCall('discard', () => awaitTransaction(tx))
      return true
    })
  )
})

const ackHandoffCompanyNameEffect = Effect.fn('UploadHandoff.ackCompanyName')(function* (
  factory: IDBFactory
) {
  return yield* withHandoffDb(
    factory,
    Effect.fn('UploadHandoff.ackCompanyName.write')(function* (db: IDBDatabase) {
      const tx = yield* openTransaction(db, INTAKE_STORE, 'readwrite')
      tx.objectStore(INTAKE_STORE).delete(COMPANY_NAME_KEY)
      yield* handoffStoreCall('ackCompanyName', () => awaitTransaction(tx))
      return true
    })
  )
})

/** Todo fallo del sobre es advisory: se responde `false`, nunca se tira. */
function runHandoffFlag<E>(effect: Effect.Effect<boolean, E>): Promise<boolean> {
  return runServerEffect(
    effect.pipe(Effect.match({ onSuccess: (value) => value, onFailure: () => false }))
  )
}

// ============================================================================
// LAS SEIS OPERACIONES — las mismas firmas que reexporta la fachada
// ============================================================================

/**
 * Parks a new selection across hosted auth. A non-empty selection deliberately
 * replaces a previous batch; returning false means the caller must not claim the
 * bytes were preserved.
 */
export async function stashHandoff({ files, companyName, nonce }: HandoffStash): Promise<boolean> {
  const factory = getFactory()
  if (!factory || files.length === 0 || !nonce) return false

  return runHandoffFlag(stashHandoffEffect(factory, { files, companyName, nonce }))
}

/**
 * Reads a recoverable intake without consuming it. Expiration is an explicit
 * terminal policy and is reported distinctly so the UI can ask for re-selection.
 * The company name outlives the files: a temporary-intake batch acknowledges its
 * bytes before the room ever opens, and the name still has to name that room.
 */
export async function peekHandoff(): Promise<HandoffPeekResult> {
  const factory = getFactory()
  if (!factory) return UNAVAILABLE_HANDOFF

  return runServerEffect(
    peekHandoffEffect(factory).pipe(
      Effect.match({ onSuccess: (result) => result, onFailure: () => UNAVAILABLE_HANDOFF })
    )
  )
}

/** Removes only records whose durable backend outcome was confirmed. */
export async function ackHandoffFiles(ids: readonly HandoffFileId[]): Promise<boolean> {
  const factory = getFactory()
  if (!factory) return false
  const uniqueIds = [...new Set(ids)]
  if (uniqueIds.some((id) => !Number.isSafeInteger(id) || id < 0)) return false
  if (uniqueIds.length === 0) return true

  return runHandoffFlag(ackHandoffFilesEffect(factory, uniqueIds))
}

/**
 * Tira el sobre SOLO si sigue siendo el de esta llave. Un stash que venció su
 * cota y terminó tarde escribe un sobre que ya nadie puede reclamar — la visita
 * siguió sin llave en la URL —, y borrarlo a ciegas se llevaría el sobre de un
 * gesto posterior, que ya lleva otra llave. Se borra registro por registro y
 * solo los que la traen.
 */
export async function discardHandoffWithNonce(nonce: string): Promise<boolean> {
  const factory = getFactory()
  if (!factory || !nonce) return false

  return runHandoffFlag(discardHandoffWithNonceEffect(factory, nonce))
}

/**
 * Tira el sobre completo — bytes y nombre — sin reclamar que su contenido llegó
 * a ningún lado. Es lo contrario del ack: se usa cuando el handoff ya no le
 * pertenece a nadie (una sala que no lo originó, un stash que no se pudo
 * escribir), para que ninguna visita posterior lo vuelva a aplicar.
 */
export async function discardHandoff(): Promise<boolean> {
  const factory = getFactory()
  if (!factory) return false

  return runHandoffFlag(discardHandoffEffect(factory))
}

/** Removes the parked name once a room actually carries it. */
export async function ackHandoffCompanyName(): Promise<boolean> {
  const factory = getFactory()
  if (!factory) return false

  return runHandoffFlag(ackHandoffCompanyNameEffect(factory))
}
