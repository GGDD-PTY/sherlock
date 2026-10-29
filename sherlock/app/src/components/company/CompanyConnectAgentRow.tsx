'use client'

import { useRef, useState } from 'react'
import { Effect, Exit, Schema } from 'effect'
import { useTranslations } from 'next-intl'

import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { runClientEffectExit } from '@/lib/effect/client-runtime'
import { getPublicVdrMcpUrl } from '@/lib/site/brand'
import { cn } from '@/lib/utils'

// ===== LA COSTURA CON EFFECT =====
// Copiar al portapapeles es un programa con nombre porque falla de dos maneras
// distintas y las dos importan: `navigator.clipboard` no existe fuera de un
// contexto seguro (y ahí el acceso revienta antes de devolver la promesa), y el
// navegador puede negar el permiso. `Effect.tryPromise` manda las dos al canal
// de error, así que el botón sabe cuándo decirle al dueño que copie a mano.
class ClipboardWriteFailed extends Schema.TaggedError<ClipboardWriteFailed>()(
  'ClipboardWriteFailed',
  { cause: Schema.Defect() }
) {}

const copyMcpCommand = Effect.fn('RoomMcp.copyCommand')(function* (
  command: string
): Effect.fn.Return<void, ClipboardWriteFailed> {
  yield* Effect.tryPromise({
    try: () => navigator.clipboard.writeText(command),
    catch: (cause) => new ClipboardWriteFailed({ cause }),
  })
})

type CopyState = 'idle' | 'copied' | 'failed'

/**
 * La fila «Conecta tu agente» al pie de la pantalla «Equipo»: el comando que
 * conecta el MCP del cliente a SU sala, para copiarlo y pegarlo en Claude Code
 * o en Claude Cowork. Es una fila de lista, no una tarjeta
 * (docs/design-system-vdr.md, «Densidad y espaciado»).
 */
export function CompanyConnectAgentRow({ className }: { className?: string }) {
  const t = useTranslations('roomWorkspace.mcp')
  const [copyState, setCopyState] = useState<CopyState>('idle')
  const lastAttempt = useRef(0)
  const command = t('command', { url: getPublicVdrMcpUrl() })

  // Manda el último clic: dos copias en vuelo pueden resolverse al revés y
  // dejar el acuse del intento viejo encima del nuevo.
  async function handleCopy() {
    lastAttempt.current += 1
    const attempt = lastAttempt.current
    const exit = await runClientEffectExit(copyMcpCommand(command))
    if (attempt !== lastAttempt.current) return
    setCopyState(Exit.isSuccess(exit) ? 'copied' : 'failed')
  }

  return (
    <section aria-labelledby="company-connect-agent-heading" className={cn(className)}>
      <ul className="divide-border border-border divide-y border-y">
        <li className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-2">
          <div className="min-w-0">
            <h2
              id="company-connect-agent-heading"
              className="font-sans text-sm leading-tight font-semibold"
            >
              {t('title')}
            </h2>
            <p className="text-muted-foreground text-sm leading-snug">{t('description')}</p>
            {/* El acuse vive pegado a la descripción: un `<p>` vacío no abre
                línea, así que la fila no cambia de alto al copiar. */}
            <p role="status" className="text-muted-foreground text-xs leading-snug">
              {copyState === 'failed' ? t('copyFailed') : ''}
            </p>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <code className="bg-muted font-data max-w-full overflow-x-auto rounded px-2 py-1 text-xs whitespace-pre">
              {command}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void handleCopy()
              }}
            >
              {copyState === 'copied' ? t('copied') : t('copy')}
            </Button>
            <Link
              href="/ayuda#mcp"
              className="text-primary text-sm font-medium underline underline-offset-4"
            >
              {t('howItWorks')}
            </Link>
          </div>
        </li>
      </ul>
    </section>
  )
}
