import { TaskQueue } from './queue.js'

type TaskFn<T> = () => Promise<T>

export class KeyedTaskQueue {
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly queue: TaskQueue

  constructor(maxConcurrency: number = 1) {
    this.queue = new TaskQueue(maxConcurrency)
  }

  async enqueue<T>(key: string, fn: TaskFn<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const next = previous.then(
      async () => await this.queue.enqueue(fn),
      async () => await this.queue.enqueue(fn),
    )
    this.tails.set(key, next)
    void next.finally(() => {
      if (this.tails.get(key) === next) {
        this.tails.delete(key)
      }
    })
    return await next
  }
}
