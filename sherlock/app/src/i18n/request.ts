// ============================================================================
// i18n REQUEST HANDLER
// ============================================================================
// Configura next-intl para Server Components
// Este archivo es requerido por next-intl para funcionar con App Router
// ============================================================================

import { getRequestConfig } from 'next-intl/server'
import messages from '@/messages/es.json'
import { defaultLocale } from './config'

export default getRequestConfig(async () => ({
  locale: defaultLocale,
  messages,
}))
