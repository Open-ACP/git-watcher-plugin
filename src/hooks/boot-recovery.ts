import type { WatcherStore } from '../storage/watcher-store.js'
import type { QueueStore } from '../storage/queue-store.js'
import type { PairWorkerPool } from '../workers/pair-worker.js'

/**
 * On startup:
 * 1. Reset any 'processing' jobs back to 'pending' (they were interrupted by shutdown)
 * 2. Notify all workers so they pick up pending jobs
 */
export async function bootRecovery(
  watcherStore: WatcherStore,
  queueStore: QueueStore,
  workerPool: PairWorkerPool,
  log: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void },
): Promise<void> {
  const watchers = await watcherStore.list()

  for (const watcher of watchers) {
    for (const downstream of watcher.downstreams) {
      // Step 1: Reset processing → pending for crash recovery
      await queueStore.resetProcessing(watcher.id, downstream.id)

      // Step 2: Notify worker to drain any pending jobs
      workerPool.notify(watcher.id, downstream.id)
    }
  }

  log.info(`Boot recovery complete for ${watchers.length} watcher(s)`)
}
