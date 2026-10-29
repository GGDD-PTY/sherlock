// ============================================================================
// FICHA DE LA EMPRESA — SECTOR, INDUSTRIA Y ETAPA SON TEXTO LIBRE
// ============================================================================
// [F] 2026-09-17: `industry`, `sector` y `stage` pasan a texto libre. Antes
// eran tres uniones de literales (11 sectores, 55 industrias, la escalera de
// venture) y un guard comparaba esas listas contra el catálogo de
// `constants/sectors.ts`. Ese catálogo se borró: no quedan dos listas que
// puedan derivar.
//
// Lo que este test pinnea es el contrato nuevo: los tres campos aceptan
// cualquier cadena, en el tipo de la fila y en el validador que las mutations
// publican al servidor, y `seekingType` sigue siendo una lista cerrada. Volver
// a cerrar cualquiera de los tres deja de compilar acá.
// ============================================================================

import { describe, it, expect } from 'vitest'
import { createCompany, updateCompany } from '../../../convex/companies'
import type { Doc } from '../../../convex/_generated/dataModel'
import { convexArgsValidator, unionLiteralsOf } from '../utils/convex-test-utils'

type CompanyRow = Doc<'companies'>

function validatorTypeOf(validator: Record<string, unknown>, field: string): string {
  const properties = validator.value as Record<string, { fieldType: { type: string } }>
  const entry = properties[field]
  if (!entry) throw new Error(`el validador no declara "${field}"`)
  return entry.fieldType.type
}

describe('sector, industria y etapa son texto libre', () => {
  it('takes any string in the three fields of a companies row', () => {
    // Asignación tipada: si alguno vuelve a ser un union de literales, esta
    // fila deja de compilar.
    const row: Pick<CompanyRow, 'sector' | 'industry' | 'stage'> = {
      sector: 'Agroindustria, alimentos y transporte',
      industry: 'Molienda de arroz y flota propia',
      stage: 'Empresa familiar, tercera generación',
    }

    expect(row.sector).toBe('Agroindustria, alimentos y transporte')
    expect(row.industry).toBe('Molienda de arroz y flota propia')
    expect(row.stage).toBe('Empresa familiar, tercera generación')
  })

  it('declares sector, industry and stage as plain strings in createCompany', () => {
    const validator = convexArgsValidator(createCompany)

    expect(validatorTypeOf(validator, 'sector')).toBe('string')
    expect(validatorTypeOf(validator, 'industry')).toBe('string')
    expect(validatorTypeOf(validator, 'stage')).toBe('string')
  })

  it('declares sector and industry as plain strings in updateCompany', () => {
    const validator = convexArgsValidator(updateCompany)

    expect(validatorTypeOf(validator, 'sector')).toBe('string')
    expect(validatorTypeOf(validator, 'industry')).toBe('string')
  })

  // La apertura llega hasta acá y no más: el instrumento que se busca sigue
  // siendo una lista cerrada, y un valor fuera de ella lo rechaza el servidor.
  it('keeps seekingType a closed list', () => {
    expect(unionLiteralsOf(convexArgsValidator(updateCompany), 'seekingType')).toEqual([
      'DEBT',
      'EQUITY',
      'BOTH',
    ])
  })
})
