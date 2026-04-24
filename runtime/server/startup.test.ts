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
})
