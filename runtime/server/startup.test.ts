import { describe, expect, it, vi } from 'vitest'
import { runWithFailFast } from './startup.js'

describe('runWithFailFast', () => {
  it('logs startup errors and exits with code 1', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const exit = vi.fn()

    runWithFailFast(async () => {
      throw new Error('boom')
    }, logger, exit)

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(logger.error).toHaveBeenCalledWith('startup-failed', {
      error: 'boom',
    })
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails fast on unhandled rejections after running shutdown once', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const exit = vi.fn()
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const processRef = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
        return processRef
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event)
        return processRef
      }),
    }

    runWithFailFast(async () => ({ shutdown }), logger, exit, processRef as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    handlers.get('unhandledRejection')?.(new Error('async boom'))
    handlers.get('unhandledRejection')?.(new Error('second boom'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(logger.error).toHaveBeenCalledWith('runtime-failed', {
      source: 'unhandledRejection',
      error: 'async boom',
    })
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
  })

  it('fails fast on uncaught exceptions and logs shutdown failures', async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const exit = vi.fn()
    const shutdown = vi.fn().mockRejectedValue(new Error('close failed'))
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const processRef = {
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        handlers.set(event, handler)
        return processRef
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event)
        return processRef
      }),
    }

    runWithFailFast(async () => shutdown, logger, exit, processRef as never)
    await new Promise((resolve) => setTimeout(resolve, 0))

    handlers.get('uncaughtException')?.(new Error('sync boom'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(logger.error).toHaveBeenCalledWith('runtime-failed', {
      source: 'uncaughtException',
      error: 'sync boom',
    })
    expect(logger.error).toHaveBeenCalledWith('runtime-shutdown-failed', {
      source: 'uncaughtException',
      error: 'close failed',
    })
    expect(exit).toHaveBeenCalledWith(1)
  })
})
