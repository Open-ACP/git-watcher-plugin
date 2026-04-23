import { describe, it, expect, beforeEach } from 'vitest'
import { QueueStore } from '../storage/queue-store.js'
import type { QueueItem } from '../types.js'

function makeStorage() {
  const data = new Map<string, unknown>()
  return {
    get: async <T>(key: string): Promise<T | null> => (data.get(key) as T) ?? null,
    set: async (key: string, value: unknown): Promise<void> => { data.set(key, value) },
    delete: async (key: string): Promise<void> => { data.delete(key) },
    list: async (): Promise<string[]> => Array.from(data.keys()),
    getDataDir: () => '/tmp/test',
  }
}

function makeJob(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: 'job_1',
    watcherId: 'watcher_a',
    downstreamId: 'down_1',
    prNumber: 42,
    prUrl: 'https://github.com/owner/repo/pull/42',
    deliveryId: 'delivery-1',
    enqueuedAt: new Date().toISOString(),
    status: 'pending',
    attempts: 0,
    ...overrides,
  }
}

describe('QueueStore', () => {
  let store: QueueStore

  beforeEach(() => {
    store = new QueueStore(makeStorage() as any)
  })

  it('enqueues and retrieves items', async () => {
    const job = makeJob()
    await store.enqueue(job)
    const items = await store.getItems('watcher_a', 'down_1')
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('job_1')
  })

  it('updates an item', async () => {
    const job = makeJob()
    await store.enqueue(job)
    await store.updateItem({ ...job, status: 'done' })
    const items = await store.getItems('watcher_a', 'down_1')
    expect(items[0].status).toBe('done')
  })

  it('resets processing items to pending on boot recovery', async () => {
    await store.enqueue(makeJob({ status: 'processing', id: 'job_1' }))
    await store.enqueue(makeJob({ status: 'done', id: 'job_2' }))
    await store.resetProcessing('watcher_a', 'down_1')
    const items = await store.getItems('watcher_a', 'down_1')
    expect(items.find(i => i.id === 'job_1')?.status).toBe('pending')
    expect(items.find(i => i.id === 'job_2')?.status).toBe('done')
  })

  it('tracks index for pairs', async () => {
    await store.enqueue(makeJob())
    const index = await store.getIndex()
    expect(index).toContainEqual({ watcherId: 'watcher_a', downstreamId: 'down_1' })
  })
})
