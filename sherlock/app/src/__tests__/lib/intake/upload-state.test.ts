// ============================================================================
// ESTADO POR ARCHIVO DEL INTAKE: HUELLA Y ESTADO PREVIO
// ============================================================================
// El flag `supersedePending` se decide por el estado terminal que ese MISMO
// archivo tuvo en el lote anterior. La huella (nombre, tamaño, lastModified)
// lo reconoce aunque cambie de posición en la selección; un archivo nuevo no
// tiene estado previo y nunca pide supersedir.
// ============================================================================

import { describe, expect, it } from 'vitest'

import {
  fileFingerprint,
  previousStatesByFingerprint,
  shouldSupersedePending,
  type IntakeUploadEntry,
} from '@/lib/intake/upload-state'

function pdf(name: string, size: number, lastModified = 1): File {
  const file = new File([name], name, { type: 'application/pdf', lastModified })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

describe('fileFingerprint', () => {
  it('no depende de la posición: dos File con el mismo nombre, tamaño y fecha coinciden', () => {
    expect(fileFingerprint(pdf('estados.pdf', 4096))).toBe(
      fileFingerprint(pdf('estados.pdf', 4096))
    )
  })

  it.each([
    ['nombre', pdf('otro.pdf', 4096)],
    ['tamaño', pdf('estados.pdf', 4097)],
    ['lastModified', pdf('estados.pdf', 4096, 2)],
  ])('cambia con el %s', (_, other) => {
    expect(fileFingerprint(pdf('estados.pdf', 4096))).not.toBe(fileFingerprint(other))
  })
})

describe('previousStatesByFingerprint + shouldSupersedePending', () => {
  it('cancelar, agregar un archivo y reintentar: el cancelado supersede, el nuevo no', () => {
    const cancelled = pdf('en-vuelo.pdf', 4096)
    const previousBatch: IntakeUploadEntry[] = [
      { key: `0:${cancelled.name}`, file: cancelled, state: { kind: 'cancelled' } },
    ]
    const previous = previousStatesByFingerprint(previousBatch)

    // Nueva selección con el archivo nuevo DELANTE: el cancelado pasa del
    // índice 0 al 1, y la huella lo sigue encontrando.
    const retry = [pdf('nuevo.pdf', 1024), pdf('en-vuelo.pdf', 4096)]
    expect(
      retry.map((file) => shouldSupersedePending(previous.get(fileFingerprint(file))))
    ).toEqual([false, true])
  })

  it('un archivo recibido o fallido por tipo/tamaño/intent no supersede', () => {
    const received = pdf('recibido.pdf', 100)
    const tooBig = pdf('grande.pdf', 200)
    const previous = previousStatesByFingerprint([
      { key: '0', file: received, state: { kind: 'received' } },
      { key: '1', file: tooBig, state: { kind: 'failed', reason: 'size' } },
    ])
    expect(shouldSupersedePending(previous.get(fileFingerprint(received)))).toBe(false)
    expect(shouldSupersedePending(previous.get(fileFingerprint(tooBig)))).toBe(false)
  })

  it('un fallo de bytes, red o registro sí supersede al reintentar', () => {
    const failed = pdf('fallido.pdf', 300)
    for (const reason of ['bytes', 'network', 'register'] as const) {
      const previous = previousStatesByFingerprint([
        { key: '0', file: failed, state: { kind: 'failed', reason } },
      ])
      expect(shouldSupersedePending(previous.get(fileFingerprint(failed)))).toBe(true)
    }
  })
})
