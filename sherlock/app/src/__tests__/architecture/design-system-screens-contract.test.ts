import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const APP_ROOT = path.resolve(__dirname, '..', '..', '..')
const REPO_ROOT = path.resolve(APP_ROOT, '..', '..')

function read(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8')
}

function classNameOf(source: string, id: string): string {
  const match = new RegExp(`id="${id}"[\\s\\S]*?className=\\{\`([^\`]+)\`\\}`).exec(source)
  if (match === null || match[1] === undefined) return ''
  return match[1]
}

// [F] 2026-09-11 18:53: cada ruta es una pantalla por intención; [F] 2026-09-14
// devuelve el tema por defecto a «system». Este pin lee el contrato y los dos
// archivos que deciden el primer paint; si uno diverge, el build lo dice.
describe('screens and canvas contract (docs/design-system.md)', () => {
  it('keeps the binding section and its rules', () => {
    const source = read('docs/design-system.md')
    expect(source).toContain('## Screens and canvas')
    for (const rule of [
      'Cream `#F6F3EC` is the light canvas',
      'One screen per intent',
      'Hairlines separate rows inside a list only',
      'Tables over cards',
      'never copied',
    ]) {
      expect(source, rule).toContain(rule)
    }
  })

  it('boots system when nothing is stored, in the provider and in the pre-paint script', () => {
    const provider = read('sherlock/app/src/components/providers/ThemeProvider.tsx')
    const boot = read('sherlock/app/src/lib/theme/boot-script.ts')
    expect(provider).toMatch(/const DEFAULT_THEME: Theme = 'system'/)
    expect(boot).toContain("?s:'system'")
  })

  it('keeps burgundy deep as the dark-mode canvas only', () => {
    const globals = read('sherlock/app/src/app/globals.css')
    const rootBlock = globals.slice(globals.indexOf(':root {'), globals.indexOf('.dark {'))
    expect(rootBlock).not.toContain('--background: var(--brand-burgundy-deep)')
    const darkBlock = globals.slice(globals.indexOf('.dark {'))
    expect(darkBlock).toContain('--background: var(--brand-burgundy-deep)')
  })

  it('registers the capture scripts the verification section relies on', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts['screens:sitio']).toContain('site-screenshots.mjs')
    expect(pkg.scripts['screens:sala']).toContain('room-screenshots.mjs')
  })

  // [F] 2026-09-11 Screens and canvas: a route fits 1440x900 without page
  // scroll. O5-03 measured the 200-document room at 2502 px because the tree
  // live region (`sr-only`, position absolute) used the viewport as containing
  // block. The documents screen now fills viewport-minus-chrome and the tree
  // panel owns overflow (O5-04-4).
  it('keeps the documents room inside the 1440x900 canvas', () => {
    const client = read('sherlock/app/src/components/company/MyCompanyDocumentsClient.tsx')
    const shell = read('sherlock/app/src/components/documents/shell/RoomShell.tsx')
    const tree = read('sherlock/app/src/components/hierarchy/HierarchyTree.tsx')
    const treeRegionClass = classNameOf(shell, 'room-tree-region')
    expect(client).toContain('lg:h-[calc(100dvh-7.5rem)]')
    expect(treeRegionClass, 'room-tree-region className').toContain('relative')
    expect(treeRegionClass, 'room-tree-region className').toContain('overflow-y-auto')
    expect(shell).not.toContain('lg:h-[max(24rem,calc(100dvh-25rem))]')
    expect(tree).toContain('relative min-h-0')
    expect(tree).toContain('sr-only top-0')
  })
})
