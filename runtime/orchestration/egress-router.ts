export class EgressRouter<TEvent> {
  private readonly subscribers = new Map<string, (event: TEvent) => void>()

  subscribe(key: string, subscriber: (event: TEvent) => void): void {
    this.subscribers.set(key, subscriber)
  }

  unsubscribe(key: string): void {
    this.subscribers.delete(key)
  }

  publish(event: TEvent): void {
    for (const subscriber of this.subscribers.values()) {
      subscriber(event)
    }
  }
}

