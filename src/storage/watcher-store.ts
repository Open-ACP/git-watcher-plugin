import type { PluginStorage } from '@openacp/plugin-sdk'
import type { Watcher } from '../types.js'

const WATCHERS_KEY = 'watchers'

export class WatcherStore {
  constructor(private storage: PluginStorage) {}

  async list(): Promise<Watcher[]> {
    return (await this.storage.get<Watcher[]>(WATCHERS_KEY)) ?? []
  }

  async get(id: string): Promise<Watcher | undefined> {
    const all = await this.list()
    return all.find((w) => w.id === id)
  }

  async save(watcher: Watcher): Promise<void> {
    const all = await this.list()
    const idx = all.findIndex((w) => w.id === watcher.id)
    if (idx >= 0) {
      all[idx] = watcher
    } else {
      all.push(watcher)
    }
    await this.storage.set(WATCHERS_KEY, all)
  }

  async delete(id: string): Promise<void> {
    const all = await this.list()
    await this.storage.set(WATCHERS_KEY, all.filter((w) => w.id !== id))
  }
}
