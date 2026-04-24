import type { Logger } from '../core/logger.js'

export function runWithFailFast(
  main: () => Promise<void>,
  logger: Logger,
  exit: (code: number) => never | void = process.exit,
): void {
  void main().catch((error) => {
    logger.error('startup-failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    exit(1)
  })
}
