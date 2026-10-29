import { beforeEach, describe, expect, it } from 'vitest'

import { addDemoDocument, getDemoDocuments } from '@/lib/dev-auth/demo-browser-store'

describe('demo-browser-store documents fail-closed scope', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('returns no documents when called without any scope', () => {
    expect(getDemoDocuments()).toEqual([])
    expect(getDemoDocuments({})).toEqual([])
  })

  it('returns no documents for an empty-string companyId (guest without company scope)', () => {
    expect(getDemoDocuments({ companyId: '' })).toEqual([])
  })

  it('returns no documents for an undefined companyId', () => {
    expect(getDemoDocuments({ companyId: undefined })).toEqual([])
  })

  it('never leaks company B documents into a company A scope', () => {
    addDemoDocument({
      companyId: 'demo_company_b',
      name: 'Company B confidential memo',
      accessLevel: 'NDA_REQUIRED',
      fileType: 'application/pdf',
      folder: 'Financieros',
    })

    const companyADocuments = getDemoDocuments({ companyId: 'demo_company_001' })

    expect(companyADocuments.length).toBeGreaterThan(0)
    expect(companyADocuments.every((document) => document.companyId === 'demo_company_001')).toBe(
      true
    )
  })

  it('never leaks documents from another company into a company scope', () => {
    addDemoDocument({
      companyId: 'demo_company_b',
      name: 'Company B attachment',
      accessLevel: 'NDA_REQUIRED',
      fileType: 'application/pdf',
      folder: 'Diligence',
    })
    addDemoDocument({
      companyId: 'demo_company_a',
      name: 'Company A attachment',
      accessLevel: 'NDA_REQUIRED',
      fileType: 'application/pdf',
      folder: 'Diligence',
    })

    const documents = getDemoDocuments({ companyId: 'demo_company_a' })

    expect(documents.map((document) => document.name)).toEqual(['Company A attachment'])
  })
})

describe('demo-browser-store — filas corruptas en localStorage', () => {
  const DOCUMENTS_KEY = 'sherlock.demo.documents.v1'

  const VALID_DOCUMENT = {
    id: 'demo_doc_valido',
    companyId: 'demo_company_x',
    name: 'Estados financieros 2025',
    accessLevel: 'NDA_REQUIRED',
    fileType: 'application/pdf',
    folder: 'Financieros',
    createdAt: '2026-05-20T00:00:00.000Z',
  }

  beforeEach(() => {
    window.localStorage.clear()
  })

  it('descarta las filas que no son documentos y conserva las que sí', () => {
    window.localStorage.setItem(
      DOCUMENTS_KEY,
      JSON.stringify([
        1,
        null,
        'no soy un documento',
        { id: 'sin_nombre', companyId: 'demo_company_x' },
        { ...VALID_DOCUMENT, accessLevel: 'TOP_SECRET' },
        VALID_DOCUMENT,
      ])
    )

    const documents = getDemoDocuments({ companyId: 'demo_company_x' })

    expect(documents.map((document) => document.id)).toEqual(['demo_doc_valido'])
    expect(documents[0].name).toBe('Estados financieros 2025')
  })

  it('un JSON que no es arreglo deja el store en su semilla, sin tirar', () => {
    window.localStorage.setItem(DOCUMENTS_KEY, '{"documents":[]}')

    expect(getDemoDocuments({ companyId: 'demo_company_001' })).toHaveLength(4)
  })
})
