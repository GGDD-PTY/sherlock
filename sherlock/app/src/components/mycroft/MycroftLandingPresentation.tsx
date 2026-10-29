'use client'

import { useEffect, useRef, useState } from 'react'
import { Effect, Exit, Schema } from 'effect'
import { useTranslations } from 'next-intl'
import { FileText, FileSpreadsheet } from 'lucide-react'
import styles from '@/components/mycroft/landing.module.css'

import { Link } from '@/i18n/navigation'
import { runClientEffectExit } from '@/lib/effect/client-runtime'
import { getPublicVdrMcpUrl } from '@/lib/site/brand'

class LandingClipboardError extends Schema.TaggedError<LandingClipboardError>()(
  'LandingClipboardError',
  { cause: Schema.Defect() }
) {}

const copyMcpUrl = Effect.fn('LandingMcp.copyUrl')(function* () {
  yield* Effect.tryPromise({
    try: () => navigator.clipboard.writeText(getPublicVdrMcpUrl()),
    catch: (cause) => new LandingClipboardError({ cause }),
  })
})

export function LandingAgentPanel() {
  const t = useTranslations('mycroft.intake.mcp')
  const mcpUrl = new URL(getPublicVdrMcpUrl())
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const lastAttempt = useRef(0)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      lastAttempt.current += 1
      if (resetTimer.current) clearTimeout(resetTimer.current)
    },
    []
  )

  async function handleCopy() {
    lastAttempt.current += 1
    const attempt = lastAttempt.current
    if (resetTimer.current) clearTimeout(resetTimer.current)
    const result = await runClientEffectExit(copyMcpUrl())
    if (attempt !== lastAttempt.current) return
    setCopyState(Exit.isSuccess(result) ? 'copied' : 'failed')
    if (Exit.isSuccess(result)) {
      resetTimer.current = setTimeout(() => setCopyState('idle'), 2000)
    }
  }

  return (
    <aside
      className="dark:border-border min-w-0 border-t border-[color-mix(in_srgb,var(--brand-cream)_15%,transparent)] bg-[var(--brand-burgundy-deep)] p-4 text-[var(--brand-cream)] sm:border-t-0 sm:border-l"
      aria-labelledby="landing-mcp-title"
    >
      <p className="font-data text-xs tracking-[0.12em] text-[var(--brand-ochre)] uppercase">
        {t('eyebrow')}
      </p>
      <h2 id="landing-mcp-title" className="mt-1 font-sans text-base leading-snug font-semibold">
        {t('title')}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-[color-mix(in_srgb,var(--brand-cream)_80%,transparent)]">
        {t('body')}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-2 rounded-md border border-[color-mix(in_srgb,var(--brand-cream)_42%,transparent)] px-2 py-1">
        <code className="font-data min-w-[145px] flex-1 text-xs leading-relaxed break-all select-all">
          <span className="block">{mcpUrl.host}</span>
          <span className="block">{mcpUrl.pathname}</span>
        </code>
        <button
          type="button"
          onClick={() => {
            void handleCopy()
          }}
          className="min-h-8 rounded-sm text-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ochre)]"
          aria-live="polite"
        >
          {copyState === 'copied' ? t('copied') : t('copy')}
        </button>
      </div>
      {copyState === 'failed' ? (
        <p role="status" className="mt-2 text-sm">
          {t('copyFailed')}
        </p>
      ) : null}
      <Link
        href="/ayuda#mcp"
        className="mt-2 inline-flex min-h-6 items-center text-sm underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand-ochre)]"
      >
        {t('how')}
      </Link>
    </aside>
  )
}

const EXAMPLE_ROWS = [
  { key: 'revenue', values: ['8,000', '9,200', '10,600'] },
  { key: 'margin', values: ['3,200', '3,800', '4,500'] },
  { key: 'ebitda', values: ['1,200', '1,500', '1,900'] },
  { key: 'cash', values: ['600', '800', '1,100'] },
] as const

export function LandingDocumentStack() {
  const t = useTranslations('mycroft.stack')
  return (
    <figure className={styles.stack} aria-label={t('example')}>
      <div className={styles.pages}>
        <div className={`${styles.paper} ${styles.cim}`}>
          <div className={styles.filebar}>
            <FileText size={12} aria-hidden="true" />
            {t('cim')}
          </div>
          <div className={styles.cover}>
            <p className="text-[10px]">{t('company')}</p>
            <p className={styles.coverTitle}>{t('cimTitle')}</p>
          </div>
        </div>
        <div className={`${styles.paper} ${styles.teaser}`}>
          <div className={styles.filebar}>
            <FileText size={12} aria-hidden="true" />
            {t('teaser')}
          </div>
          <div className={styles.teaserBody}>
            <p className={styles.teaserTitle}>{t('teaserTitle')}</p>
            <p className={styles.teaserCopy}>{t('teaserBody')}</p>
          </div>
        </div>
        <div className={`${styles.paper} ${styles.model}`}>
          <div className={styles.filebar}>
            <FileSpreadsheet size={12} aria-hidden="true" />
            {t('model')}
          </div>
          <div className={styles.tabs} aria-hidden="true">
            <span>{t('summary')}</span>
            <span>{t('pl')}</span>
            <span>{t('assumptions')}</span>
            <span>{t('scenarios')}</span>
          </div>
          <table className={styles.table} aria-label={`${t('model')}, ${t('example')}`}>
            <thead>
              <tr>
                <th scope="col">{t('unit')}</th>
                {[0, 1, 2].map((year) => (
                  <th key={year} scope="col">
                    {t(`years.${year}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {EXAMPLE_ROWS.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{t(`rows.${row.key}`)}</th>
                  {row.values.map((value) => (
                    <td key={value}>{value}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className={styles.chart} aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className={styles.modelNote}>{t('growth')}</p>
        </div>
      </div>
      <figcaption className={styles.caption}>{t('example')}</figcaption>
    </figure>
  )
}

const RECEIVE_KEYS = ['model', 'materials', 'process'] as const

export function LandingDetails() {
  const t = useTranslations('mycroft')
  return (
    <section aria-labelledby="landing-receive-title" className={styles.details}>
      <h2 id="landing-receive-title">{t('receive.title')}</h2>
      <div className={styles.deliverables}>
        {RECEIVE_KEYS.map((key) => (
          <div key={key}>
            <h3>{t(`receive.${key}.title`)}</h3>
            <p>{t(`receive.${key}.body`)}</p>
          </div>
        ))}
      </div>
      <p className={styles.team}>{t('team.compact')}</p>
    </section>
  )
}
