type MoneyFormatOptions = {
  readonly compact?: boolean
  readonly currency: string
  readonly locale: string
}

// [F] 2026-09-03 23:30: el sitio es solo en español. Toda cifra sale en es-PA
// aunque el llamador viva en una ruta `[locale]`.
const INTL_LOCALE = 'es-PA'

const moneyFormatters = new Map<string, Intl.NumberFormat>()

export function formatMoney(
  amount: number,
  { compact = false, currency, locale: _locale }: MoneyFormatOptions
): string {
  const intlLocale = INTL_LOCALE
  const cacheKey = `${intlLocale}:${currency}:${compact ? 'compact' : 'standard'}`
  let formatter = moneyFormatters.get(cacheKey)

  if (!formatter) {
    formatter = new Intl.NumberFormat(intlLocale, {
      style: 'currency',
      currency,
      ...(compact ? { notation: 'compact', maximumFractionDigits: 1 } : {}),
      ...(compact ? {} : { maximumFractionDigits: 0 }),
    })
    moneyFormatters.set(cacheKey, formatter)
  }

  return formatter.format(amount)
}

// Las razones sociales panameñas suelen terminar en «S. A.» o «Inc.»: la
// plantilla conserva su punto final; este helper quita el del nombre.
export function nameAtSentenceEnd(name: string): string {
  return name.endsWith('.') ? name.slice(0, -1) : name
}
