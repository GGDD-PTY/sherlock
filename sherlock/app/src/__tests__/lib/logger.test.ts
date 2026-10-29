// ============================================================================
// LOGGER UNIT TESTS
// ============================================================================
// Tests para el sistema de logging centralizado
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createLogger, log, loggers } from '@/lib/logger'

describe('Logger', () => {
  // Standardized console mocking using vi.spyOn (same pattern as errors.test.ts)
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('createLogger', () => {
    it('creates a logger with specified module name', () => {
      const logger = createLogger('TestModule')
      logger.info('Test message')

      expect(console.info).toHaveBeenCalled()
      const logMessage = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(logMessage).toContain('TestModule')
    })
  })

  describe('log levels', () => {
    it('logs debug messages in development', () => {
      const logger = createLogger('Test')
      logger.debug('Debug message')

      // In test environment, debug should be logged
      expect(console.log).toHaveBeenCalled()
    })

    it('logs info messages', () => {
      const logger = createLogger('Test')
      logger.info('Info message')

      expect(console.info).toHaveBeenCalled()
    })

    it('logs warn messages', () => {
      const logger = createLogger('Test')
      logger.warn('Warning message')

      expect(console.warn).toHaveBeenCalled()
    })

    it('logs error messages', () => {
      const logger = createLogger('Test')
      logger.error('Error message')

      expect(console.error).toHaveBeenCalled()
    })
  })

  describe('context handling', () => {
    it('includes context in log output', () => {
      const logger = createLogger('Test')
      logger.info('Test message', { userId: '123', path: '/api/test' })

      expect(console.info).toHaveBeenCalled()
      const logMessage = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(logMessage).toContain('userId')
    })

    it('extracts error information from Error objects', () => {
      const logger = createLogger('Test')
      const testError = new Error('Test error message')
      logger.error('Operation failed', { error: testError })

      expect(console.error).toHaveBeenCalled()
      const logMessage = (console.error as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(logMessage).toContain('Test error message')
    })
  })

  describe('time function', () => {
    it('measures operation duration', () => {
      // Use fake timers for deterministic testing
      vi.useFakeTimers()

      const logger = createLogger('Test')
      const endTimer = logger.time('TestOperation')

      // Advance timers by 100ms
      vi.advanceTimersByTime(100)

      endTimer()

      // Restore real timers
      vi.useRealTimers()

      expect(console.info).toHaveBeenCalled()
      const logMessage = (console.info as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(logMessage).toContain('TestOperation')
      expect(logMessage).toContain('completed')
    })
  })

  describe('default exports', () => {
    it('exports default log instance', () => {
      expect(log).toBeDefined()
      expect(typeof log.info).toBe('function')
    })

    it('exports pre-created loggers for common modules', () => {
      expect(loggers.auth).toBeDefined()
      expect(loggers.onboarding).toBeDefined()
      expect(loggers.payments).toBeDefined()
      expect(loggers.api).toBeDefined()
      expect(loggers.db).toBeDefined()
      expect(loggers.storage).toBeDefined()
    })
  })
})
