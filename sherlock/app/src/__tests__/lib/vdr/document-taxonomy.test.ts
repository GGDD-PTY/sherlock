import { describe, expect, it } from 'vitest'

import {
  getVdrFolderLabel,
  getVdrFolderValue,
  getVdrShellFolderLabel,
  getVdrShellFolderValue,
  VDR_DOCUMENT_FOLDERS,
  VDR_SHELL_FOLDERS,
  inferVdrFolderFromName,
  VDR_SHELL_FALLBACK_FOLDER,
} from '@/lib/vdr/document-taxonomy'

// Se arma fuera de todo caso: un `??` dentro del `it` sería un condicional en la
// prueba, y acá cada alias es su propio caso con nombre.
const SHELL_ALIASES = VDR_SHELL_FOLDERS.flatMap((folder) =>
  (folder.aliases ?? []).map((alias) => [alias, folder.value])
)

describe('VDR document taxonomy', () => {
  it('sentence-cases operations and debt labels and keeps Quality of Earnings', () => {
    expect(getVdrFolderLabel('operations', 'es')).toBe('KPIs operativos')
    expect(getVdrFolderLabel('debt_schedule', 'es')).toBe('Cronograma de deuda')
    expect(getVdrFolderLabel('qoe', 'es')).toBe('Quality of Earnings')
  })

  it('keeps core investment-banking data-room folders available', () => {
    expect(VDR_DOCUMENT_FOLDERS.map((folder) => folder.value)).toEqual([
      'teaser',
      'management_presentation',
      'financials',
      'model',
      'cap_table',
      'qoe',
      'debt_schedule',
      'legal',
      'operations',
      'data_room_index',
      'technical',
      'room_legal',
      'room_corporate',
      'room_financial',
      'room_operations',
      'room_marketing',
      'other',
    ])
  })

  it('keeps `other` last so unknown folders still resolve to it', () => {
    expect(VDR_DOCUMENT_FOLDERS[VDR_DOCUMENT_FOLDERS.length - 1].value).toBe('other')
    expect(getVdrFolderLabel('carpeta inventada', 'es')).toBe('Otros')
  })

  // El default de `findVdrFolder` era `VDR_DOCUMENT_FOLDERS[length - 1]`: mover
  // `other` de lugar mandaba en silencio todo lo no clasificado a la carpeta que
  // quedara última. Ahora el default es `other` POR NOMBRE, así que la tabla se
  // puede reordenar sin cambiar a dónde cae un valor desconocido.
  it('resuelve el default por nombre y no por posición en la tabla', () => {
    const original = [...VDR_DOCUMENT_FOLDERS]

    try {
      VDR_DOCUMENT_FOLDERS.splice(0, VDR_DOCUMENT_FOLDERS.length, ...original.toReversed())

      expect(VDR_DOCUMENT_FOLDERS.at(-1)?.value).toBe('teaser')
      expect(getVdrFolderValue('carpeta inventada')).toBe('other')
      expect(getVdrFolderLabel('carpeta inventada', 'es')).toBe('Otros')
    } finally {
      VDR_DOCUMENT_FOLDERS.splice(0, VDR_DOCUMENT_FOLDERS.length, ...original)
    }
  })
})

describe('VDR shell folders', () => {
  it('exposes exactly the five fixed first-level folders, in process order', () => {
    expect(VDR_SHELL_FOLDERS.map((folder) => folder.value)).toEqual([
      'room_legal',
      'room_corporate',
      'room_financial',
      'room_operations',
      'room_marketing',
    ])
    expect(VDR_SHELL_FOLDERS.map((folder) => folder.label.es)).toEqual([
      '1. Legales',
      '2. Corporativos',
      '3. Financieros',
      '4. Operaciones',
      '5. Materiales de mercadeo',
    ])
  })

  it('migrates the legacy taxonomy into the five visible folders', () => {
    expect(getVdrShellFolderValue('legal')).toBe('room_legal')
    expect(getVdrShellFolderValue('cap_table')).toBe('room_corporate')
    expect(getVdrShellFolderValue('financials')).toBe('room_financial')
    expect(getVdrShellFolderValue('model')).toBe('room_financial')
    expect(getVdrShellFolderValue('debt_schedule')).toBe('room_financial')
    expect(getVdrShellFolderValue('operations')).toBe('room_operations')
    expect(getVdrShellFolderValue('technical')).toBe('room_operations')
    expect(getVdrShellFolderValue('teaser')).toBe('room_marketing')
    expect(getVdrShellFolderValue('management_presentation')).toBe('room_marketing')
  })

  it('migrates legacy demo labels and free text without losing documents', () => {
    expect(getVdrShellFolderValue('Financieros')).toBe('room_financial')
    expect(getVdrShellFolderValue('Diligence')).toBe('room_corporate')
    expect(getVdrShellFolderValue('Legal')).toBe('room_legal')
    expect(getVdrShellFolderValue('General')).toBe('room_corporate')
    expect(getVdrShellFolderValue(null)).toBe('room_corporate')
    expect(getVdrShellFolderValue('carpeta inventada')).toBe('room_corporate')
  })

  it('round-trips its own canonical values and labels', () => {
    for (const folder of VDR_SHELL_FOLDERS) {
      expect(getVdrShellFolderValue(folder.value)).toBe(folder.value)
      expect(getVdrShellFolderValue(folder.label.es)).toBe(folder.value)
      expect(getVdrShellFolderLabel(folder.value, 'es')).toBe(folder.label.es)
    }
  })

  // El mapa término → carpeta se arma recorriendo las cinco carpetas: si dos
  // reclamaran el mismo alias, la que ganara dependería del orden de la tabla y
  // los documentos de una aparecerían en la otra. Este es el candado.
  it.each(SHELL_ALIASES)('el alias «%s» sólo lo reclama %s', (alias, folder) => {
    expect(getVdrShellFolderValue(alias)).toBe(folder)
  })

  // La etiqueta del valor no reconocido salía de `VDR_SHELL_FOLDERS[1]`. Este
  // caso pasa por el default sin tocar ninguna posición.
  it('etiqueta un valor desconocido con la carpeta de respaldo', () => {
    expect(getVdrShellFolderLabel('carpeta inventada', 'es')).toBe('2. Corporativos')
    expect(getVdrShellFolderLabel(null, 'es')).toBe('2. Corporativos')
  })
})

describe('VDR legacy taxonomy behavior', () => {
  it('normalizes legacy demo folders into canonical labels', () => {
    expect(getVdrFolderLabel('Diligence', 'es')).toBe('Índice del Data Room')
    expect(getVdrFolderLabel('Financieros', 'es')).toBe('Estados Financieros')
    expect(getVdrFolderLabel('Modelo', 'es')).toBe('Modelo Financiero')
    expect(getVdrFolderLabel(null, 'es')).toBe('Otros')
  })
})

describe('inferVdrFolderFromName — ruteo de la landing por nombre de archivo', () => {
  it.each([
    ['INA_LAKRAF_2025_0.pdf', 'room_financial'],
    ['INT_LAKRAF_2026_Q1.pdf', 'room_financial'],
    ['INA_SAMPLE_ENERGY_2024_FY_v01.pdf', 'room_financial'],
    ['EEFF auditados 2025.pdf', 'room_financial'],
    ['Estados Financieros 2024.xlsx', 'room_financial'],
    ['Pacto Social Andina Solar.pdf', 'room_corporate'],
    ['Acta de asamblea 2026.pdf', 'room_corporate'],
    ['NDA - Inversionista.docx', 'room_legal'],
    ['Contrato de arrendamiento planta.pdf', 'room_legal'],
    ['Teaser Andina Solar.pptx', 'room_marketing'],
    ['Inventario 2026-Q1.csv', 'room_operations'],
    ['Nomina agosto.xlsx', 'room_operations'],
  ])('%s → %s', (name, folder) => {
    expect(inferVdrFolderFromName(name)).toBe(folder)
  })

  it('cae a la carpeta de respaldo cuando el nombre no dice nada', () => {
    expect(inferVdrFolderFromName('scan_0001.pdf')).toBe(VDR_SHELL_FALLBACK_FOLDER)
    expect(inferVdrFolderFromName('')).toBe(VDR_SHELL_FALLBACK_FOLDER)
    expect(inferVdrFolderFromName(null)).toBe(VDR_SHELL_FALLBACK_FOLDER)
  })

  it('no confunde "internacional" con INT ni "final" con un token', () => {
    expect(inferVdrFolderFromName('Contrato internacional.pdf')).toBe('room_legal')
    expect(inferVdrFolderFromName('Acta final.pdf')).toBe('room_corporate')
  })
})
