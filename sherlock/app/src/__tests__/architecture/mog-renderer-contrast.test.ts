// From sherlock/app: bun run test:run src/__tests__/architecture/mog-renderer-contrast.test.ts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

// Test the installed renderer code, including Bun's portable patch, without
// starting the WASM/browser runtime. These functions only resolve text paint.
const require = createRequire(import.meta.url)
const bundle = readFileSync(require.resolve('@mog-sdk/spreadsheet-app'), 'utf8')
const start = bundle.indexOf('function normalizeFontColor(')
const end = bundle.indexOf('function computeTextAlign(', start)
if (start < 0 || end < 0) throw new Error('MOG renderer boundary changed; review the patch')
const resolveColor: (
  format: { fontColor?: string; backgroundColor?: string },
  skin: string,
  background?: string
) => string = runInNewContext(
  `const DEFAULT_CELL_STYLE = { fontColor: '#000000' };\n${bundle.slice(start, end)}\nresolveCellTextColor`
)

describe('installed MOG automatic text contrast', () => {
  it.each([
    ['#FFFFFF', '#f4f7f5', '#000000'],
    ['#F6F3EC', '#f4f7f5', '#000000'],
    ['#250E14', '#000000', '#ffffff'],
    ['#250E14', '#f4f7f5', '#f4f7f5'],
  ])('paints automatic text over %s with skin %s as %s', (fill, skin, expected) => {
    const format = Object.freeze({ backgroundColor: fill })
    expect(resolveColor(format, skin)).toBe(expected)
    expect(format).toEqual({ backgroundColor: fill })
  })

  it.each(['#008000', '#0000FF', '#FF0000', '#FFFFFF'])(
    'preserves explicit stored financial color %s',
    (fontColor) => {
      const format = Object.freeze({ backgroundColor: '#FFFFFF', fontColor })
      expect(resolveColor(format, '#f4f7f5')).toBe(fontColor)
    }
  )

  it('preserves the skin for cells without a stored fill', () => {
    expect(resolveColor({}, '#f4f7f5')).toBe('#f4f7f5')
    expect(resolveColor({ fontColor: '#000000' }, '#f4f7f5')).toBe('#f4f7f5')
  })

  it('keeps default black readable on a stored white fill without rewriting the cell', () => {
    const cell = Object.freeze({
      value: 1234.56,
      formula: '=SUM(B2:B8)',
      format: Object.freeze({
        fontColor: '#000000',
        backgroundColor: '#FFFFFF',
        numberFormat: '$#,##0.00',
      }),
    })
    const before = JSON.stringify(cell)
    expect(resolveColor(cell.format, '#f4f7f5')).toBe('#000000')
    expect(JSON.stringify(cell)).toBe(before)
  })
})

describe('installed MOG translucent fill guard', () => {
  it.each([
    'rgba(255,255,255,0)',
    'rgba(255,255,255,0.25)',
    '#ffffff00',
    '#fff0',
    'rgba(255,255,255,invalid)',
  ])('preserves skin for non-opaque or unsupported fill %s', (backgroundColor) => {
    const format = Object.freeze({ backgroundColor })
    expect(resolveColor(format, '#f4f7f5')).toBe('#f4f7f5')
    expect(format.backgroundColor).toBe(backgroundColor)
  })
})

describe('installed MOG author color precedence on opaque fills', () => {
  it.each(['#000000', '#f4f7f5'])(
    'preserves declared black and white over black with skin %s',
    (skin) => {
      expect(
        resolveColor(Object.freeze({ backgroundColor: '#000000', fontColor: '#000000' }), skin)
      ).toBe('#000000')
      expect(
        resolveColor(Object.freeze({ backgroundColor: '#000000', fontColor: '#FFFFFF' }), skin)
      ).toBe('#FFFFFF')
    }
  )
})

// Exercise the actual CellsLayer dispatch, with only the final canvas painter
// substituted: a missing dispatch hookup must fail even if the helper is present.
const dispatchStart = bundle.indexOf('      renderCellText(ctx,')
const dispatchEnd = bundle.indexOf('      renderInCellImage(', dispatchStart)
if (dispatchStart < 0 || dispatchEnd < 0) throw new Error('MOG cell dispatch changed')

const luminance = (hex: string) =>
  [1, 3, 5]
    .map((offset) => {
      const c = parseInt(hex.slice(offset, offset + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0)

describe('installed MOG skin-owned background text paint', () => {
  it.each([
    { fontColor: '#1F302D', dominant: 1, other: 0 },
    { fontColor: '#0000FF', dominant: 2, other: 0 },
    { fontColor: '#FF0000', dominant: 0, other: 2 },
  ])(
    'adapts %s without removing its financial color distinction',
    ({ fontColor, dominant, other }) => {
      const color = resolveColor({ fontColor }, '#f4f7f5', '#15191d')
      expect(color).not.toBe(fontColor)
      const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16))
      expect(rgb[dominant]).toBeGreaterThan(rgb[other])
      expect((luminance(color) + 0.05) / (luminance('#15191d') + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it.each([
    {
      cfBackground: null,
      sameFormat: false,
      expected: resolveColor({ fontColor: '#18332C' }, '#f4f7f5', '#15191d'),
    },
    { cfBackground: '#FFFFFF', expected: '#18332C', sameFormat: true },
  ])(
    'uses a transient paint format and respects CF background %s',
    ({ cfBackground, expected, sameFormat }) => {
      let painted: { fontColor?: string } | undefined
      const dispatch: (...args: unknown[]) => void = runInNewContext(
        `const DEFAULT_CELL_STYLE={fontColor:'#000000'};\n${bundle.slice(start, end)}\n({${bundle.slice(dispatchStart, dispatchEnd)}}).renderCellText`,
        {
          renderRichTextWrapped: (
            ...args: [
              unknown,
              unknown,
              unknown,
              unknown,
              unknown,
              unknown,
              { fontColor?: string },
              unknown,
            ]
          ) => {
            painted = args[6]
          },
        }
      )
      const format = Object.freeze({
        fontColor: '#18332C',
        patternType: 'none',
        wrapText: true,
        numberFormat: '$#,##0.00',
      })
      const before = JSON.stringify(format)
      dispatch.call(
        {
          sheetData: {
            sheetViewSkin: { defaultCellText: '#f4f7f5', defaultCellBackground: '#15191d' },
          },
        },
        null,
        { x: 0, y: 0, width: 100, height: 20, row: 0, col: 0 },
        format,
        1,
        'Synthetic financial row',
        [{ text: 'Synthetic financial row' }],
        false,
        null,
        {},
        {},
        { getBgColorOverride: () => cfBackground }
      )
      expect(painted?.fontColor).toBe(expected)
      expect(Object.is(painted, format)).toBe(sameFormat)
      expect(JSON.stringify(format)).toBe(before)
    }
  )
})
