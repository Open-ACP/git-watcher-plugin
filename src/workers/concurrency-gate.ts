/**
 * Simple semaphore limiting how many AI sessions can run concurrently across
 * all pair workers. Each worker acquires a slot before spawning a session and
 * releases it after the session completes.
 */
export class ConcurrencyGate {
  private active = 0
  private queue: Array<() => void> = []

  constructor(private max: number) {}

  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active++
        resolve()
      })
    })
  }

  release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }

  get activeCount(): number {
    return this.active
  }

  get waitingCount(): number {
    return this.queue.length
  }
}
