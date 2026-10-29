import { describe, expect, it } from 'vitest'

import { officeBytesMatchContentType } from '../../../convex/_documents/officeFileInspection'
import { buildCfbFixture } from '../utils/cfb-fixtures'
import {
  asciiBytes,
  buildOoxmlFixture,
  buildZipFixture,
  zipWithAppendedTail,
} from '../utils/zip-fixtures'

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'

describe('Office container inspection', () => {
  it.each([
    [XLSX, 'xlsx'],
    [DOCX, 'docx'],
    [PPTX, 'pptx'],
  ] as const)('accepts a structurally valid %s package', (mimeType, kind) => {
    expect(officeBytesMatchContentType(mimeType, buildOoxmlFixture(kind))).toBe(true)
  })

  it('accepts deflated manifests and main parts written by Office', () => {
    expect(
      officeBytesMatchContentType(
        XLSX,
        buildOoxmlFixture('xlsx', { deflateManifest: true, deflateMainPart: true })
      )
    ).toBe(true)
  })

  it('rejects a generic ZIP renamed as OOXML', () => {
    expect(officeBytesMatchContentType(XLSX, buildZipFixture(['payload.bin']))).toBe(false)
  })

  it('rejects an OOXML package declared as the wrong subtype', () => {
    expect(officeBytesMatchContentType(DOCX, buildOoxmlFixture('xlsx'))).toBe(false)
  })

  it.each([
    ['missing manifest declaration', { manifestXml: '<Types/>' }],
    ['missing root relationship', { omitRootRels: true }],
    ['missing main part', { omitRequiredPart: true }],
    ['wrong main root', { mainPartXml: '<workbook/>' }],
  ])('rejects %s', (_label, options) => {
    expect(officeBytesMatchContentType(XLSX, buildOoxmlFixture('xlsx', options))).toBe(false)
  })

  it('rejects data appended after an otherwise valid package', () => {
    const disguised = zipWithAppendedTail(
      buildOoxmlFixture('xlsx'),
      asciiBytes('unaccounted-payload')
    )
    expect(officeBytesMatchContentType(XLSX, disguised)).toBe(false)
  })

  it.each([
    ['application/vnd.ms-excel', 'Workbook'],
    ['application/msword', 'WordDocument'],
    ['application/vnd.ms-powerpoint', 'PowerPoint Document'],
  ])('accepts a legacy %s container with its required stream', (mimeType, stream) => {
    expect(officeBytesMatchContentType(mimeType, buildCfbFixture([stream]))).toBe(true)
  })

  it('rejects a generic OLE container and a legacy subtype mismatch', () => {
    const genericOle = buildCfbFixture(['PropertySet'])
    const workbook = buildCfbFixture(['Workbook'])

    expect(officeBytesMatchContentType('application/vnd.ms-excel', genericOle)).toBe(false)
    expect(officeBytesMatchContentType('application/msword', workbook)).toBe(false)
  })
})
