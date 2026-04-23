import type { PluginStorage } from '@openacp/plugin-sdk'
import type { QueueItem } from '../types.js'

const INDEX_KEY = 'queue-index'

// Each pair's queue is stored as 'queue:<watcherId>:<downstreamId>'
function queueKey(watcherId: string, downstreamId: string): string {
  return `queue:${watcherId}:${downstreamId}`
}

export class QueueStore {
  constructor(private storage: PluginStorage) {}

  async getItems(watcherId: string, downstreamId: string): Promise<QueueItem[]> {
    return (await this.storage.get<QueueItem[]>(queueKey(watcherId, downstreamId))) ?? []
  }

  async enqueue(item: QueueItem): Promise<void> {
    const items = await this.getItems(item.watcherId, item.downstreamId)
    items.push(item)
    await this.storage.set(queueKey(item.watcherId, item.downstreamId), items)
    await this.addToIndex(item.watcherId, item.downstreamId)
  }

  async updateItem(item: QueueItem): Promise<void> {
    const items = await this.getItems(item.watcherId, item.downstreamId)
    const idx = items.findIndex((i) => i.id === item.id)
    if (idx >= 0) {
      items[idx] = item
      await this.storage.set(queueKey(item.watcherId, item.downstreamId), items)
    }
  }

  async removeItem(watcherId: string, downstreamId: string, jobId: string): Promise<void> {
    const items = await this.getItems(watcherId, downstreamId)
    await this.storage.set(
      queueKey(watcherId, downstreamId),
      items.filter((i) => i.id !== jobId),
    )
  }

  async clearQueue(watcherId: string, downstreamId: string): Promise<void> {
    await this.storage.set(queueKey(watcherId, downstreamId), [])
  }

  async getIndex(): Promise<Array<{ watcherId: string; downstreamId: string }>> {
    return (await this.storage.get<Array<{ watcherId: string; downstreamId: string }>>(INDEX_KEY)) ?? []
  }

  private async addToIndex(watcherId: string, downstreamId: string): Promise<void> {
    const index = await this.getIndex()
    const exists = index.some((e) => e.watcherId === watcherId && e.downstreamId === downstreamId)
    if (!exists) {
      index.push({ watcherId, downstreamId })
      await this.storage.set(INDEX_KEY, index)
    }
  }

  async addPairToIndex(watcherId: string, downstreamId: string): Promise<void> {
    return this.addToIndex(watcherId, downstreamId)
  }

  async removePairFromIndex(watcherId: string, downstreamId: string): Promise<void> {
    const index = await this.getIndex()
    await this.storage.set(
      INDEX_KEY,
      index.filter((e) => !(e.watcherId === watcherId && e.downstreamId === downstreamId)),
    )
  }

  // Boot recovery: reset all 'processing' items to 'pending'
  async resetProcessing(watcherId: string, downstreamId: string): Promise<void> {
    const items = await this.getItems(watcherId, downstreamId)
    let changed = false
    for (const item of items) {
      if (item.status === 'processing') {
        item.status = 'pending'
        changed = true
      }
    }
    if (changed) {
      await this.storage.set(queueKey(watcherId, downstreamId), items)
    }
  }
}
