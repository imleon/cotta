type Logger = {
  error: (event: string, fields?: Record<string, unknown>) => void
}

export class EgressRouter<TEvent> {
  private readonly subscribers = new Map<string, (event: TEvent) => void>()

  constructor(private readonly logger?: Logger) {}

  subscribe(key: string, subscriber: (event: TEvent) => void): void {
    this.subscribers.set(key, subscriber)
  }

  unsubscribe(key: string): void {
    this.subscribers.delete(key)
  }

  publish(event: TEvent): void {
    // Iterate over a snapshot so a subscriber can safely unsubscribe itself
    // without perturbing delivery for the rest of the current publish cycle.
    for (const [key, subscriber] of [...this.subscribers.entries()]) {
      try {
        subscriber(event)
      } catch (error) {
        this.logger?.error('egress-router:subscriber-error', {
          subscriberKey: key,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}
