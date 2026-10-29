import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HANDOFF_TTL_MS,
  ackHandoffCompanyName,
  ackHandoffFiles,
  discardHandoff,
  discardHandoffWithNonce,
  peekHandoff,
  stashHandoff,
} from '@/lib/mycroft/upload-handoff'

const NONCE = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

function makeFile(name: string, content: string, type = 'application/pdf'): File {
  return new File([content], name, { type, lastModified: 1_700_000_000_000 })
}

describe('mycroft upload handoff', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('peeks files without destroying them before durable acknowledgement', async () => {
    const stashed = await stashHandoff({
      files: [
        makeFile('modelo.xlsx', 'contenido-modelo', 'application/vnd.ms-excel'),
        makeFile('teaser.pdf', 'contenido-teaser'),
      ],
      nonce: NONCE,
    })
    expect(stashed).toBe(true)

    const first = await peekHandoff()
    const second = await peekHandoff()

    expect(first.status).toBe('READY')
    expect(first.files.map(({ file }) => file.name)).toEqual(['modelo.xlsx', 'teaser.pdf'])
    expect(first.files[0].file.type).toBe('application/vnd.ms-excel')
    expect(await first.files[1].file.text()).toBe('contenido-teaser')
    expect(second.files.map(({ id }) => id)).toEqual(first.files.map(({ id }) => id))
  })

  it('acknowledges only files with durable success and leaves failed files recoverable', async () => {
    await stashHandoff({
      files: [
        makeFile('subido.pdf', 'a'),
        makeFile('fallido.pdf', 'b'),
        makeFile('pendiente.pdf', 'c'),
      ],
      nonce: NONCE,
    })
    const pending = await peekHandoff()

    expect(await ackHandoffFiles([pending.files[0].id, pending.files[2].id])).toBe(true)

    const remaining = await peekHandoff()
    expect(remaining.status).toBe('READY')
    expect(remaining.files.map(({ file }) => file.name)).toEqual(['fallido.pdf'])
  })

  it('keeps records when acknowledgement itself fails', async () => {
    await stashHandoff({ files: [makeFile('modelo.pdf', 'x')], nonce: NONCE })
    const pending = await peekHandoff()
    const factory = globalThis.indexedDB
    // Simulate storage becoming unavailable after the upload succeeds. The caller
    // must receive false rather than a false claim that local recovery was cleared.
    // @ts-expect-error test-only unavailable IndexedDB
    delete globalThis.indexedDB

    expect(await ackHandoffFiles([pending.files[0].id])).toBe(false)

    globalThis.indexedDB = factory
    expect((await peekHandoff()).files).toHaveLength(1)
  })

  it('a new stash replaces the previous one', async () => {
    await stashHandoff({ files: [makeFile('viejo.pdf', 'a')], nonce: NONCE })
    await stashHandoff({ files: [makeFile('nuevo.pdf', 'b')], nonce: NONCE })

    const peeked = await peekHandoff()
    expect(peeked.files.map(({ file }) => file.name)).toEqual(['nuevo.pdf'])
  })

  // Only spy Date.now: fake-indexeddb dispatches callbacks on real timers.
  it('reports an expired stash explicitly instead of a false successful handoff', async () => {
    const base = 1_750_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    await stashHandoff({ files: [makeFile('lento.pdf', 'x')], nonce: NONCE })

    nowSpy.mockReturnValue(base + HANDOFF_TTL_MS + 1)
    expect(await peekHandoff()).toEqual({
      status: 'EXPIRED',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
    expect(await peekHandoff()).toEqual({
      status: 'EMPTY',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
    nowSpy.mockRestore()
  })

  it('keeps the stash within the TTL window', async () => {
    const base = 1_750_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    await stashHandoff({ files: [makeFile('rapido.pdf', 'x')], nonce: NONCE })

    nowSpy.mockReturnValue(base + HANDOFF_TTL_MS - 1000)
    expect((await peekHandoff()).files).toHaveLength(1)
    nowSpy.mockRestore()
  })

  it('reports unavailable IndexedDB distinctly', async () => {
    // @ts-expect-error simulates private mode/no IndexedDB
    delete globalThis.indexedDB

    expect(await stashHandoff({ files: [makeFile('x.pdf', 'x')], nonce: NONCE })).toBe(false)
    expect(await peekHandoff()).toEqual({
      status: 'UNAVAILABLE',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
  })

  it('reports an empty stash without throwing', async () => {
    expect(await peekHandoff()).toEqual({
      status: 'EMPTY',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
  })

  it('parks the typed company name beside the files and keeps it after the bytes are acknowledged', async () => {
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: '  Agroindustrias Espavé  ',
      nonce: NONCE,
    })
    const parked = await peekHandoff()
    expect(parked.companyName).toBe('Agroindustrias Espavé')

    // Temporary intake acknowledges the bytes before the room ever opens; the
    // name still has to reach that room.
    expect(await ackHandoffFiles([parked.files[0].id])).toBe(true)
    const afterUpload = await peekHandoff()
    expect(afterUpload.status).toBe('EMPTY')
    expect(afterUpload.companyName).toBe('Agroindustrias Espavé')

    expect(await ackHandoffCompanyName()).toBe(true)
    expect((await peekHandoff()).companyName).toBeNull()
  })

  it('treats a blank name as no name and expires it with the batch', async () => {
    await stashHandoff({ files: [makeFile('modelo.pdf', 'x')], companyName: '   ', nonce: NONCE })
    expect((await peekHandoff()).companyName).toBeNull()

    const base = 1_750_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: 'Espavé',
      nonce: NONCE,
    })
    nowSpy.mockReturnValue(base + HANDOFF_TTL_MS + 1)
    expect(await peekHandoff()).toEqual({
      status: 'EXPIRED',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
    nowSpy.mockRestore()
  })

  it('a new selection replaces the previous name instead of inheriting it', async () => {
    await stashHandoff({
      files: [makeFile('viejo.pdf', 'a')],
      companyName: 'Primera',
      nonce: NONCE,
    })
    await stashHandoff({ files: [makeFile('nuevo.pdf', 'b')], nonce: NONCE })

    expect((await peekHandoff()).companyName).toBeNull()
  })

  it('does not clear a previous stash for an empty selection', async () => {
    await stashHandoff({ files: [makeFile('modelo.pdf', 'x')], nonce: NONCE })

    expect(await stashHandoff({ files: [], nonce: NONCE })).toBe(false)
    expect((await peekHandoff()).files.map(({ file }) => file.name)).toEqual(['modelo.pdf'])
  })

  // Un cliente que ya había parqueado archivos vuelve con una base v1. Si la
  // subida de versión recreara el store en vez de agregar el que falta, esa
  // selección desaparecería sin que nada se lo dijera.
  it('upgrades a v1 database in place instead of dropping the parked files', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = globalThis.indexedDB.open('sherlock-mycroft-handoff', 1)
      request.onupgradeneeded = () => request.result.createObjectStore('files', { keyPath: 'id' })
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('files', 'readwrite')
        tx.objectStore('files').put({
          id: 0,
          name: 'heredado.pdf',
          type: 'application/pdf',
          lastModified: 1_700_000_000_000,
          bytes: new TextEncoder().encode('viejo').buffer,
          stashedAt: Date.now(),
        })
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
      }
    })

    const peeked = await peekHandoff()
    expect(peeked.status).toBe('READY')
    expect(peeked.files.map(({ file }) => file.name)).toEqual(['heredado.pdf'])
    expect(peeked.companyName).toBeNull()
  })

  it('reports a failed name acknowledgement instead of claiming the record is gone', async () => {
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: 'Espavé',
      nonce: NONCE,
    })
    const factory = globalThis.indexedDB
    // @ts-expect-error simulates private mode/no IndexedDB
    delete globalThis.indexedDB

    expect(await ackHandoffCompanyName()).toBe(false)

    globalThis.indexedDB = factory
    expect((await peekHandoff()).companyName).toBe('Espavé')
  })

  // Un registro sobrevive al código que lo escribió. Un nombre sin `stashedAt`
  // no tiene reloj contra el cual expirar, así que no puede nombrar una sala.
  it('ignores a stored name whose shape it cannot vouch for', async () => {
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: 'Espavé',
      nonce: NONCE,
    })
    await new Promise<void>((resolve, reject) => {
      const request = globalThis.indexedDB.open('sherlock-mycroft-handoff')
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('intake', 'readwrite')
        tx.objectStore('intake').put({ key: 'companyName', name: 'Espavé' })
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
      }
    })

    expect((await peekHandoff()).companyName).toBeNull()
  })

  // El handoff viaja en un navegador, no en una sesión: sin la hora en que se
  // parqueó, la sala no puede probar que ese sobre es el de su propia alta.
  it('reports when the batch was parked so the room can prove the handoff is its own', async () => {
    const base = 1_750_000_000_000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(base)
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: 'Espavé',
      nonce: NONCE,
    })

    nowSpy.mockReturnValue(base + 60_000)
    const parked = await peekHandoff()
    expect(parked.status).toBe('READY')
    expect(parked.stashedAt).toBe(base)

    // El nombre sobrevive a los bytes y conserva la misma hora de parqueo.
    expect(await ackHandoffFiles([parked.files[0].id])).toBe(true)
    const afterUpload = await peekHandoff()
    expect(afterUpload.status).toBe('EMPTY')
    expect(afterUpload.stashedAt).toBe(base)
    nowSpy.mockRestore()
  })

  it('discards the whole parked intake, bytes and name, in one shot', async () => {
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: 'Espavé',
      nonce: NONCE,
    })

    expect(await discardHandoff()).toBe(true)

    expect(await peekHandoff()).toEqual({
      status: 'EMPTY',
      files: [],
      companyName: null,
      stashedAt: null,
      nonce: null,
    })
  })

  it('reports a failed discard instead of claiming the parked intake is gone', async () => {
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: 'Espavé',
      nonce: NONCE,
    })
    const factory = globalThis.indexedDB
    // @ts-expect-error simulates private mode/no IndexedDB
    delete globalThis.indexedDB

    expect(await discardHandoff()).toBe(false)

    globalThis.indexedDB = factory
    expect((await peekHandoff()).files).toHaveLength(1)
  })
})

describe('mycroft upload handoff nonce', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    vi.useRealTimers()
  })

  // El nonce es la llave del sobre: viaja en la URL del alta y la sala solo
  // reclama el sobre cuyo nonce coincide. Nombre y bytes llevan el mismo.
  it('parks the nonce beside the files and keeps it on the name after the bytes are acknowledged', async () => {
    await stashHandoff({
      files: [makeFile('modelo.pdf', 'x')],
      companyName: 'Espavé',
      nonce: 'nonce-alta-1',
    })

    const parked = await peekHandoff()
    expect(parked.status).toBe('READY')
    expect(parked.nonce).toBe('nonce-alta-1')

    expect(await ackHandoffFiles([parked.files[0].id])).toBe(true)
    const afterUpload = await peekHandoff()
    expect(afterUpload.status).toBe('EMPTY')
    expect(afterUpload.companyName).toBe('Espavé')
    expect(afterUpload.nonce).toBe('nonce-alta-1')
  })

  it('a new stash replaces the nonce with the previous batch', async () => {
    await stashHandoff({ files: [makeFile('viejo.pdf', 'a')], nonce: 'nonce-1' })
    await stashHandoff({ files: [makeFile('nuevo.pdf', 'b')], nonce: 'nonce-2' })

    expect((await peekHandoff()).nonce).toBe('nonce-2')
  })

  it('reports no nonce when nothing survives', async () => {
    expect((await peekHandoff()).nonce).toBeNull()
    await stashHandoff({ files: [makeFile('modelo.pdf', 'x')], nonce: 'nonce-1' })
    expect(await discardHandoff()).toBe(true)
    expect((await peekHandoff()).nonce).toBeNull()
  })

  // Un sobre escrito por código anterior no tiene nonce: la sala no lo puede
  // emparejar con ninguna URL, así que se reporta sin llave y se descarta allá.
  it('reports a legacy envelope without nonce instead of inventing one', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = globalThis.indexedDB.open('sherlock-mycroft-handoff', 2)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('files', { keyPath: 'id' })
        request.result.createObjectStore('intake', { keyPath: 'key' })
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction(['files', 'intake'], 'readwrite')
        tx.objectStore('files').put({
          id: 0,
          name: 'heredado.pdf',
          type: 'application/pdf',
          lastModified: 1_700_000_000_000,
          bytes: new TextEncoder().encode('viejo').buffer,
          stashedAt: Date.now(),
        })
        tx.objectStore('intake').put({ key: 'companyName', name: 'Espavé', stashedAt: Date.now() })
        tx.onerror = () => reject(tx.error)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
      }
    })

    const peeked = await peekHandoff()
    expect(peeked.status).toBe('READY')
    expect(peeked.nonce).toBeNull()
    expect(peeked.companyName).toBeNull()
  })

  // El stash que venció su cota y terminó tarde escribe un sobre que ninguna
  // visita puede reclamar: la continuación ya se fue sin llave en la URL. Se
  // borra bajo su propia llave y no queda residuo.
  it('discards an envelope by its own nonce, bytes and name', async () => {
    await stashHandoff({
      files: [makeFile('tardio.pdf', 'a')],
      companyName: 'Espavé',
      nonce: 'nonce-tardio',
    })

    expect(await discardHandoffWithNonce('nonce-tardio')).toBe(true)

    const peeked = await peekHandoff()
    expect(peeked.status).toBe('EMPTY')
    expect(peeked.files).toHaveLength(0)
    expect(peeked.companyName).toBeNull()
    expect(peeked.nonce).toBeNull()
  })

  // Y no toca el sobre de un gesto posterior, que ya lleva otra llave: el
  // cliente volvió a soltar archivos mientras el stash viejo seguía en vuelo.
  it('leaves an envelope parked under a different nonce untouched', async () => {
    await stashHandoff({
      files: [makeFile('nuevo.pdf', 'b')],
      companyName: 'Espavé Holdings',
      nonce: 'nonce-nuevo',
    })

    expect(await discardHandoffWithNonce('nonce-tardio')).toBe(true)

    const peeked = await peekHandoff()
    expect(peeked.status).toBe('READY')
    expect(peeked.files.map(({ file }) => file.name)).toEqual(['nuevo.pdf'])
    expect(peeked.companyName).toBe('Espavé Holdings')
    expect(peeked.nonce).toBe('nonce-nuevo')
  })

  it('refuses to discard without a nonce instead of clearing the whole envelope', async () => {
    await stashHandoff({ files: [makeFile('modelo.pdf', 'c')], nonce: 'nonce-vivo' })

    expect(await discardHandoffWithNonce('')).toBe(false)
    expect((await peekHandoff()).status).toBe('READY')
  })
})
