// ============================================================================
// LOGGER UTILITY - Sherlock UNIFIED
// ============================================================================
// Sistema centralizado de logging para observabilidad
// Niveles: debug, info, warn, error
// En producción solo muestra warn y error por defecto
// ============================================================================

import { Schema } from 'effect'

// ===== TIPOS =====
// Los cuatro niveles se escriben una vez, EN ORDEN de severidad: la tabla
// `Record<LogLevel, number>` que había antes repetía ese orden con números a
// mano, así que un nivel nuevo entraba mudo hasta que alguien se acordara de
// darle su peso.
const LogLevelSchema = Schema.Literals(['debug', 'info', 'warn', 'error'])
type LogLevel = typeof LogLevelSchema.Type
const LOG_LEVELS_BY_SEVERITY = LogLevelSchema.literals

type LogContext = {
  // Identificadores
  userId?: string
  companyId?: string

  // Metadata de request
  path?: string
  method?: string
  statusCode?: number
  duration?: number

  // Error info
  error?: Error | unknown
  stack?: string

  // Cualquier dato adicional
  [key: string]: unknown
}

// ===== CONFIGURACIÓN =====
// En producción solo warn y error, en desarrollo todo
const MIN_LEVEL: LogLevel = process.env.NODE_ENV === 'production' ? 'warn' : 'debug'

// ===== FORMATEO =====
function formatLogEntry(
  level: LogLevel,
  module: string,
  message: string,
  context?: LogContext
): string {
  const timestamp = new Date().toISOString()
  const prefix = `[${timestamp}] [${level.toUpperCase()}] [${module}]`

  // En desarrollo: formato legible
  if (process.env.NODE_ENV !== 'production') {
    const contextStr = context ? ` ${JSON.stringify(context, null, 0)}` : ''
    return `${prefix} ${message}${contextStr}`
  }

  // En producción: JSON para parseo automático (CloudWatch, Datadog, etc.)
  return JSON.stringify({
    timestamp,
    level,
    module,
    message,
    ...context,
  })
}

// ===== FUNCIÓN PRINCIPAL DE LOG =====
function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS_BY_SEVERITY.indexOf(level) >= LOG_LEVELS_BY_SEVERITY.indexOf(MIN_LEVEL)
}

// ===== LOGGER CLASS =====
// Crea un logger con un módulo específico para contexto
class Logger {
  private module: string

  constructor(module: string) {
    this.module = module
  }

  // ===== DEBUG: Para desarrollo y debugging =====
  // Usa esto para información detallada que solo necesitas durante desarrollo
  debug(message: string, context?: LogContext): void {
    if (shouldLog('debug')) {
      console.log(formatLogEntry('debug', this.module, message, context))
    }
  }

  // ===== INFO: Eventos normales de la aplicación =====
  // Usa esto para acciones completadas exitosamente
  info(message: string, context?: LogContext): void {
    if (shouldLog('info')) {
      console.info(formatLogEntry('info', this.module, message, context))
    }
  }

  // ===== WARN: Situaciones inesperadas pero manejadas =====
  // Usa esto cuando algo salió mal pero la app puede continuar
  warn(message: string, context?: LogContext): void {
    if (shouldLog('warn')) {
      console.warn(formatLogEntry('warn', this.module, message, context))
    }
  }

  // ===== ERROR: Errores que requieren atención =====
  // Usa esto para fallos que afectan funcionalidad
  error(message: string, context?: LogContext): void {
    if (shouldLog('error')) {
      // Crear copia del contexto para no mutar el original
      let enrichedContext = context

      // Si hay un error en el contexto, extraer información útil
      if (context?.error && context.error instanceof Error) {
        enrichedContext = {
          ...context,
          stack: context.error.stack,
          errorMessage: context.error.message,
          errorName: context.error.name,
        }
      }

      console.error(formatLogEntry('error', this.module, message, enrichedContext))
    }
  }

  // ===== TIME: Medir duración de operaciones =====
  // Retorna una función que al llamarla loguea la duración
  time(operationName: string): () => void {
    const start = Date.now()
    return () => {
      const duration = Date.now() - start
      this.info(`${operationName} completed`, { duration, unit: 'ms' })
    }
  }
}

// ===== FACTORY FUNCTION =====
// Uso: const log = createLogger('Onboarding')
export function createLogger(module: string): Logger {
  return new Logger(module)
}

// ===== LOGGER POR DEFECTO =====
// Para uso rápido sin crear instancia
export const log = createLogger('App')

// ===== LOGGERS PRE-CREADOS PARA MÓDULOS COMUNES =====
export const loggers = {
  auth: createLogger('Auth'),
  onboarding: createLogger('Onboarding'),
  payments: createLogger('Payments'),
  api: createLogger('API'),
  db: createLogger('Database'),
  storage: createLogger('Storage'),
}
