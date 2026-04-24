import type { Logger } from '../core/logger.js'

type ShutdownHandler = () => Promise<void> | void

type MainResult = void | ShutdownHandler | { shutdown?: ShutdownHandler }

type ProcessLike = Pick<typeof process, 'on' | 'off'>

function resolveShutdownHandler(result: MainResult): ShutdownHandler | null {
  if (typeof result === 'function') return result
  if (result && typeof result === 'object' && typeof result.shutdown === 'function') {
    return result.shutdown
  }
  return null
}

export function runWithFailFast(
  main: () => Promise<MainResult>,
  logger: Logger,
  exit: (code: number) => never | void = process.exit,
  processRef: ProcessLike = process,
): void {
  let shutdownHandler: ShutdownHandler | null = null
  let fatalTriggered = false

  const cleanupHandlers = () => {
    processRef.off('unhandledRejection', onUnhandledRejection)
    processRef.off('uncaughtException', onUncaughtException)
  }

  const handleFatal = async (source: 'unhandledRejection' | 'uncaughtException', error: unknown) => {
    if (fatalTriggered) return
    fatalTriggered = true
    logger.error('runtime-failed', {
      source,
      error: error instanceof Error ? error.message : String(error),
    })
    try {
      await shutdownHandler?.()
    } catch (shutdownError) {
      logger.error('runtime-shutdown-failed', {
        source,
        error: shutdownError instanceof Error ? shutdownError.message : String(shutdownError),
      })
    } finally {
      cleanupHandlers()
      exit(1)
    }
  }

  const onUnhandledRejection = (reason: unknown) => {
    void handleFatal('unhandledRejection', reason)
  }
  const onUncaughtException = (error: Error) => {
    void handleFatal('uncaughtException', error)
  }

  processRef.on('unhandledRejection', onUnhandledRejection)
  processRef.on('uncaughtException', onUncaughtException)

  void main().then((result) => {
    shutdownHandler = resolveShutdownHandler(result)
  }).catch((error) => {
    cleanupHandlers()
    logger.error('startup-failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    exit(1)
  })
}
