import { describe, it, expect, beforeEach } from 'vitest'
import { WatcherStore } from '../storage/watcher-store.js'
import type { Watcher } from '../types.js'

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

function makeWatcher(id = 'watcher_abc'): Watcher {
  return {
    id,
    upstream: { repo: 'owner/backend', branch: 'main', webhookId: 1, webhookSecret: 'secret' },
    downstreams: [],
    createdAt: new Date().toISOString(),
  }
}

describe('WatcherStore', () => {
  let store: WatcherStore

  beforeEach(() => {
    store = new WatcherStore(makeStorage() as any)
  })

  it('returns empty list initially', async () => {
    expect(await store.list()).toEqual([])
  })

  it('saves and retrieves a watcher', async () => {
    const watcher = makeWatcher()
    await store.save(watcher)
    expect(await store.get('watcher_abc')).toEqual(watcher)
  })

  it('updates existing watcher', async () => {
    const watcher = makeWatcher()
    await store.save(watcher)
    const updated = { ...watcher, upstream: { ...watcher.upstream, branch: 'develop' } }
    await store.save(updated)
    const result = await store.get('watcher_abc')
    expect(result?.upstream.branch).toBe('develop')
    expect((await store.list()).length).toBe(1)
  })

  it('deletes a watcher', async () => {
    await store.save(makeWatcher())
    await store.delete('watcher_abc')
    expect(await store.list()).toEqual([])
  })
})
