import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const page = readFileSync(join(process.cwd(), 'src/app/[locale]/vdr-guest/page.tsx'), 'utf8')

describe('vdr-guest page fragment bootstrap', () => {
  // o5-04-8: Next parchea window.history.replaceState. El script inline
  // llama el prototipo nativo para no despachar ACTION_RESTORE.
  it('clears the fragment through History.prototype, not the instance patch', () => {
    expect(page).toContain(
      "History.prototype.replaceState.call(history,history.state,'',location.pathname)"
    )
    expect(page).not.toContain("history.replaceState(history.state,'',location.pathname)")
  })
})
